const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    MessageFlags 
} = require('discord.js');
const { 
    appendSubmissionToSheet, 
    updateSubmissionStatusInSheet, 
    getCampaignTargetDetails, 
    isLinkSubmitted 
} = require('../utils/sheetsHelper');
const { createProgressBar } = require('../utils/progressBar');
const { fetchTikTokMetrics } = require('../utils/tiktokScraper');
const { getUserProfile } = require('./profileHandler');

async function syncCampaignCardBudget(client, tabName) {
    try {
        const channelId = process.env.ACTIVE_CAMPAIGNS_CHANNEL_ID;
        if (!channelId) return;

        const channel = client.channels.cache.get(channelId);
        if (!channel) return;

        const targetData = await getCampaignTargetDetails(tabName);
        if (!targetData) return;

        const messages = await channel.messages.fetch({ limit: 50 });
        const campaignMsg = messages.find(m => {
            if (m.author.id !== client.user.id || !m.components.length) return false;
            const btn = m.components[0]?.components[0];
            return btn && btn.customId === `submit_clip_btn_${tabName}`;
        });

        if (!campaignMsg || !campaignMsg.embeds.length) return;

        const oldEmbed = campaignMsg.embeds[0];
        const progressBarText = createProgressBar(targetData.approvedViews, targetData.targetViews);

        const updatedFields = oldEmbed.fields.map(f => {
            if (f.name.includes('Target Status') || f.name.includes('Funding Status')) {
                return { name: '🎯 Target Status', value: progressBarText, inline: false };
            }
            return f;
        });

        const updatedEmbed = EmbedBuilder.from(oldEmbed).setFields(updatedFields);
        await campaignMsg.edit({ embeds: [updatedEmbed] });
    } catch (err) {}
}

function getSubmitModal(campaignTitle = 'Clip Campaign', tabName = 'Sheet1') {
    const modal = new ModalBuilder()
        .setCustomId(`modal_clipper_submit_${tabName}`)
        .setTitle(`Submit Clip: ${campaignTitle.substring(0, 20)}`);

    const tiktokLink = new TextInputBuilder()
        .setCustomId('sub_tiktok_url')
        .setLabel('TikTok Video Link')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://www.tiktok.com/@username/video/123456789')
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tiktokLink));
    return modal;
}

async function handleClipperModalSubmit(interaction) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('modal_clipper_submit_')) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const userProfile = getUserProfile(interaction.user.id);
    if (!userProfile) {
        return interaction.editReply({
            content: '⚠️ **Profile Required!** Please set your profile first using the `👤 Set / Edit Profile` button.'
        });
    }

    const parts = interaction.customId.split('_');
    const tabName = parts.slice(3).join('_') || 'Sheet1';
    const tiktokUrl = interaction.fields.getTextInputValue('sub_tiktok_url');

    const duplicate = await isLinkSubmitted(tabName, tiktokUrl);
    if (duplicate) {
        return interaction.editReply({
            content: '⚠️ **Duplicate Submission!** This TikTok video link has already been submitted to this campaign.'
        });
    }

    const submitAdminChannel = interaction.guild.channels.cache.get(process.env.SUBMIT_ADMIN_CHANNEL_ID);
    if (!submitAdminChannel) {
        return interaction.editReply({ content: '⚠️ Admin channel `#submit` not found in .env!' });
    }

    const metrics = await fetchTikTokMetrics(tiktokUrl);
    const submissionId = `SUB-${Date.now().toString().slice(-6)}`;

    const cardDescription = 
        `👤 **Clipper** : ${interaction.user} (Account: \`${metrics.authorUsername}\`)\n` +
        `📈 **Metrics** : ${metrics.views.toLocaleString()} Views • ${metrics.likes.toLocaleString()} Likes\n` +
        `⚡ **Eng. Rate** : ${metrics.engagementScore}%\n` +
        `🔗 **Video Link** : [Watch TikTok](${tiktokUrl})\n\n` +
        `⏳ **Status** : \`Pending Review\``;

    const adminEmbed = new EmbedBuilder()
        .setTitle(`📥 SUBMISSION #${submissionId.replace('SUB-', '')} —${tabName}`)
        .setColor('#FEE75C')
        .setDescription(cardDescription)
        .setTimestamp();

    const approveBtn = new ButtonBuilder()
        .setCustomId(`approve_sub_${interaction.user.id}_${submissionId}_${tabName}`)
        .setLabel('🟢 Approve')
        .setStyle(ButtonStyle.Success);

    const rejectBtn = new ButtonBuilder()
        .setCustomId(`reject_sub_${interaction.user.id}_${submissionId}_${tabName}`)
        .setLabel('🔴 Reject')
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(approveBtn, rejectBtn);

    await submitAdminChannel.send({ embeds: [adminEmbed], components: [row] });

    // Format Baris Baru Sesuai Header Spreadsheet
    // Col A: Sub ID, Col B: User ID, Col C: User Tag, Col D: Platform, Col E: Link
    // Col F: Views, Col G: Likes, Col H: Payout (=F7*B$4), Col I: Reason, Col J: Status, Col K: Time
    const rowData = [
        submissionId,
        interaction.user.id,
        interaction.user.tag,
        'TikTok',
        tiktokUrl,
        metrics.views,
        metrics.likes,
        `=INDIRECT("F"&ROW())*B$4`, // Formula Payout Otomatis Berdasarkan Baris Terkait
        '-',
        'PENDING',
        new Date().toLocaleString()
    ];

    await appendSubmissionToSheet(tabName, rowData);

    await interaction.editReply({
        content: `✅ **Clip Submitted Successfully!** (ID: \`${submissionId}\`)\nViews (${metrics.views.toLocaleString()}) & Likes (${metrics.likes.toLocaleString()}) auto-fetched and sent for review.`
    });
}

async function handleAdminApprovalInteraction(interaction) {
    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('approve_sub_')) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const parts = interaction.customId.split('_');
        const clipperId = parts[2];
        const submissionId = parts[3];
        const tabName = parts.slice(4).join('_');

        const archiveChannel = interaction.guild.channels.cache.get(process.env.ARCHIVE_SUBMIT_CHANNEL_ID);
        const submitAdminChannel = interaction.guild.channels.cache.get(process.env.SUBMIT_ADMIN_CHANNEL_ID);

        try {
            const targetMsg = interaction.message || await submitAdminChannel.messages.fetch(interaction.message.id).catch(() => null);
            if (!targetMsg) return await interaction.editReply({ content: '⚠️ Message not found or deleted.' });

            const oldEmbed = targetMsg.embeds[0];

            const updatedDescription = oldEmbed.description.replace(
                /⏳ \*\*Status\*\* : .*/,
                `✅ **Status** : \`APPROVED by ${interaction.user.tag}\``
            );

            const approvedEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#57F287')
                .setDescription(updatedDescription);

            if (archiveChannel) {
                await archiveChannel.send({ embeds: [approvedEmbed] });
            }

            await targetMsg.delete().catch(() => {});

            // Update status ke APPROVED di Sheet
            await updateSubmissionStatusInSheet(tabName, submissionId, `APPROVED by ${interaction.user.tag}`, '-');
            await syncCampaignCardBudget(interaction.client, tabName);

            try {
                const clipperUser = await interaction.client.users.fetch(clipperId);
                await clipperUser.send(`🎉 **Congratulations!** Your submission (\`${submissionId}\`) for campaign **${tabName}** has been **APPROVED**!`);
            } catch (e) {}

            return await interaction.editReply({ content: `✅ Submission \`${submissionId}\` approved!` });

        } catch (err) {
            console.error(err);
            return await interaction.editReply({ content: '⚠️ Failed to process approval.' });
        }
    }

    if (interaction.customId.startsWith('reject_sub_')) {
        const parts = interaction.customId.split('_');
        const clipperId = parts[2];
        const submissionId = parts[3];
        const tabName = parts.slice(4).join('_');

        const modal = new ModalBuilder()
            .setCustomId(`modal_reject_reason_${clipperId}_${interaction.message.id}_${submissionId}_${tabName}`)
            .setTitle(`Reject Submission #${submissionId.replace('SUB-', '')}`);

        const reasonInput = new TextInputBuilder()
            .setCustomId('reject_reason')
            .setLabel('Reason for Rejection')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('e.g., Low engagement / View botting detected')
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
    }
}

async function handleModalProofAndRejectSubmit(interaction) {
    if (!interaction.isModalSubmit() || !interaction.customId.startsWith('modal_reject_reason_')) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts = interaction.customId.split('_');
    const clipperId = parts[3];
    const targetMsgId = parts[4];
    const submissionId = parts[5];
    const tabName = parts.slice(6).join('_');
    const reason = interaction.fields.getTextInputValue('reject_reason');

    const archiveChannel = interaction.guild.channels.cache.get(process.env.ARCHIVE_SUBMIT_CHANNEL_ID);
    const submitAdminChannel = interaction.guild.channels.cache.get(process.env.SUBMIT_ADMIN_CHANNEL_ID);

    try {
        const targetMsg = await submitAdminChannel.messages.fetch(targetMsgId).catch(() => null);
        
        if (targetMsg) {
            const oldEmbed = targetMsg.embeds[0];

            const updatedDescription = oldEmbed.description.replace(
                /⏳ \*\*Status\*\* : .*/,
                `❌ **Status** : \`REJECTED by ${interaction.user.tag} (Reason: ${reason})\``
            );

            const rejectedEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#ED4245')
                .setDescription(updatedDescription);

            if (archiveChannel) {
                await archiveChannel.send({ embeds: [rejectedEmbed] });
            }

            await targetMsg.delete().catch(() => {});
        }

        // Update status ke REJECTED di Sheet
        await updateSubmissionStatusInSheet(tabName, submissionId, `REJECTED`, reason);

        try {
            const clipperUser = await interaction.client.users.fetch(clipperId);
            await clipperUser.send(`⚠️ **Submission Rejected!** Your submission (\`${submissionId}\`) for **${tabName}** was rejected.\n\n**Reason:** ${reason}`);
        } catch (e) {}

        return await interaction.editReply({ content: `❌ Submission \`${submissionId}\` rejected.` });

    } catch (err) {
        console.error(err);
        return await interaction.editReply({ content: '⚠️ Failed to process rejection.' });
    }
}

module.exports = { 
    getSubmitModal, 
    handleClipperModalSubmit, 
    handleAdminApprovalInteraction, 
    handleModalProofAndRejectSubmit,
    syncCampaignCardBudget
};
