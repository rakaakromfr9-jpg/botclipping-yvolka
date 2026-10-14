const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const { createCampaignSpreadsheet } = require('../utils/sheetsHelper');
const { createProgressBar } = require('../utils/progressBar');

async function handleAdminPanelInteractions(interaction) {
    if (interaction.isButton() && interaction.customId === 'admin_add_campaign_btn') {
        const modal = new ModalBuilder()
            .setCustomId('modal_add_campaign')
            .setTitle('➕ Create New Campaign');

        const titleInput = new TextInputBuilder()
            .setCustomId('camp_title')
            .setLabel('Campaign Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., Growtopia TikTok Campaign')
            .setRequired(true);

        const targetViewsInput = new TextInputBuilder()
            .setCustomId('camp_target_views')
            .setLabel('Target Views (e.g. 1M or 1000000)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1000000')
            .setRequired(true);

        const payRateInput = new TextInputBuilder()
            .setCustomId('camp_budget')
            .setLabel('Pay Rate Details')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g., $10 per 10k views')
            .setRequired(true);

        const imageInput = new TextInputBuilder()
            .setCustomId('camp_image')
            .setLabel('Thumbnail Image URL (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://...')
            .setRequired(false);

        const reqInput = new TextInputBuilder()
            .setCustomId('camp_req')
            .setLabel('Requirements & Details (Manual Text)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('• Must Add Title and Name Song in Caption...\n• 3% minimum engagement\n• All content allowed...')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(targetViewsInput),
            new ActionRowBuilder().addComponents(payRateInput),
            new ActionRowBuilder().addComponents(imageInput),
            new ActionRowBuilder().addComponents(reqInput)
        );

        return await interaction.showModal(modal);
    }

    // Modal submit handler saat admin selesai ngisi campaign baru
    if (interaction.isModalSubmit() && interaction.customId === 'modal_add_campaign') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const title = interaction.fields.getTextInputValue('camp_title');
        const targetViewsRaw = interaction.fields.getTextInputValue('camp_target_views');
        const payRate = interaction.fields.getTextInputValue('camp_budget');
        const imageUrl = interaction.fields.getTextInputValue('camp_image');
        const requirements = interaction.fields.getTextInputValue('camp_req');

        let tabName = '';
        let spreadsheetUrl = '';

        // 1. OTOMATIS MEMBUAT TAB BARU DI GOOGLE SHEETS
        try {
            const result = await createCampaignSpreadsheet(title, targetViewsRaw, payRate);
            tabName = result.tabName;
            spreadsheetUrl = result.spreadsheetUrl;
        } catch (err) {
            console.error('[CAMPAIGN CREATION ERROR]:', err.message);
            return await interaction.editReply({ 
                content: `⚠️ **Failed to create Google Sheet tab!** Error: \`${err.message}\`` 
            });
        }

        // 2. KIRIM EMBED CARD KE CHANNEL ACTIVE CAMPAIGNS
        const activeChannelId = process.env.ACTIVE_CAMPAIGNS_CHANNEL_ID;
        const activeChannel = interaction.guild.channels.cache.get(activeChannelId);

        if (!activeChannel) {
            return await interaction.editReply({ 
                content: `⚠️ Active campaigns channel not found! Check \`ACTIVE_CAMPAIGNS_CHANNEL_ID\` in .env.` 
            });
        }

        const initialProgressBar = createProgressBar(0, 100);

        const campaignEmbed = new EmbedBuilder()
            .setTitle(`📌 ${title}`)
            .setColor('#5865F2')
            .setDescription(
                `📌 **REQUIREMENTS**\n${requirements}\n\n` +
                `💰 **PAYMENT DETAIL**\n` +
                `• **Rate**: \`${payRate}\`\n` +
                `• **Target**: \`${targetViewsRaw} views\``
            )
            .addFields({ 
                name: '🎯 Target Status', 
                value: initialProgressBar, 
                inline: false 
            })
            .setFooter({ text: `Tab: ${tabName} • Rune Viral` })
            .setTimestamp();

        if (imageUrl && imageUrl.startsWith('http')) {
            campaignEmbed.setThumbnail(imageUrl);
        }

        const submitBtn = new ButtonBuilder()
            .setCustomId(`submit_clip_btn_${tabName}`)
            .setLabel('📥 Submit Clip')
            .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(submitBtn);

        await activeChannel.send({ embeds: [campaignEmbed], components: [row] });

        return await interaction.editReply({
            content: `✅ **Campaign Successfully Created & Synced to Sheet!**\n\n📊 **Sheet Tab**: \`${tabName}\`\n🔗 **Spreadsheet Link**: [Open Google Sheet](${spreadsheetUrl})`
        });
    }

    if (interaction.isButton() && interaction.customId === 'admin_close_campaign_btn') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const activeChannelId = process.env.ACTIVE_CAMPAIGNS_CHANNEL_ID;
        if (!activeChannelId) {
            return await interaction.editReply({ content: '⚠️ Active campaigns channel ID not found in .env!' });
        }

        const channel = interaction.guild.channels.cache.get(activeChannelId);
        if (!channel) {
            return await interaction.editReply({ content: '⚠️ Active campaigns channel not found!' });
        }

        const messages = await channel.messages.fetch({ limit: 50 });
        const campaignOptions = [];

        messages.forEach((msg) => {
            if (msg.author.id === interaction.client.user.id && msg.embeds.length && msg.components.length) {
                const btn = msg.components[0]?.components[0];
                if (btn && btn.customId.startsWith('submit_clip_btn_')) {
                    const title = msg.embeds[0].title || 'Untitled Campaign';
                    const tabName = btn.customId.replace('submit_clip_btn_', '');
                    
                    if (!campaignOptions.some(opt => opt.value === `${msg.id}_${tabName}`)) {
                        campaignOptions.push({
                            label: title.replace('📌 ', '').substring(0, 100),
                            description: `Tab: ${tabName}`,
                            value: `${msg.id}_${tabName}`
                        });
                    }
                }
            }
        });

        if (campaignOptions.length === 0) {
            return await interaction.editReply({ content: '⚠️ No active campaigns found to close.' });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('admin_select_close_campaign')
            .setPlaceholder('Select a campaign to close & archive...')
            .addOptions(campaignOptions.slice(0, 25));

        const row = new ActionRowBuilder().addComponents(selectMenu);
        return await interaction.editReply({
            content: '⛔ **Select the campaign you want to close:**',
            components: [row]
        });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'admin_select_close_campaign') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const selectedVal = interaction.values[0] || '';
        const firstUnderscore = selectedVal.indexOf('_');
        const msgId = firstUnderscore !== -1 ? selectedVal.slice(0, firstUnderscore) : selectedVal;
        const tabName = firstUnderscore !== -1 ? selectedVal.slice(firstUnderscore + 1) : '';
        const activeChannel = interaction.guild.channels.cache.get(process.env.ACTIVE_CAMPAIGNS_CHANNEL_ID);
        const archiveChannel = interaction.guild.channels.cache.get(process.env.ARCHIVE_CAMPAIGNS_CHANNEL_ID);

        if (!activeChannel) {
            return await interaction.editReply({ content: '⚠️ Active campaigns channel not found!' });
        }

        try {
            const targetMsg = await activeChannel.messages.fetch(msgId).catch(() => null);
            if (!targetMsg) {
                return await interaction.editReply({ content: '⚠️ Campaign message not found or already deleted.' });
            }

            const oldEmbed = targetMsg.embeds[0];

            const closedEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#ED4245')
                .setTitle(`${oldEmbed.title} [CLOSED / ARCHIVED]`)
                .setFields(
                    oldEmbed.fields.map(f => {
                        if (f.name.includes('Target Status') || f.name.includes('Funding Status')) {
                            return { name: '🔴 Target Status', value: '⛔ **CAMPAIGN CLOSED BY ADMIN**', inline: false };
                        }
                        return f;
                    })
                );

            if (archiveChannel) {
                await archiveChannel.send({ embeds: [closedEmbed] });
            }

            await targetMsg.delete().catch(() => {});

            return await interaction.editReply({
                content: `✅ Campaign **${tabName}** has been successfully closed and archived!`
            });

        } catch (err) {
            console.error('[CLOSE CAMPAIGN ERROR]:', err);
            return await interaction.editReply({ content: '⚠️ Failed to close campaign.' });
        }
    }
}

module.exports = { handleAdminPanelInteractions };
