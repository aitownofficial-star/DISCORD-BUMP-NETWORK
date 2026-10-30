const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const { Pool } = require("pg");
const express = require("express");

const web = express();
const PORT = Number(process.env.PORT) || 10000;

web.get("/", (_req, res) => {
  res.status(200).send("DIF - Discord Bump Network is running.");
});

web.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "DIF",
    bot: client.isReady() ? "online" : "starting",
  });
});

web.listen(PORT, "0.0.0.0", () => {
  console.log(`[DIF] HTTP server listening on port ${PORT}`);
});

const required = ["DISCORD_TOKEN", "CLIENT_ID", "DATABASE_URL"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[DIF] 필수 환경 변수가 없습니다: ${key}`);
    process.exit(1);
  }
}

const COOLDOWN_MINUTES = 120;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("범프")
    .setDescription("DIF 범프를 실행합니다."),
  new SlashCommandBuilder()
    .setName("감지설정")
    .setDescription("외부 범프 감지 대상을 설정합니다.")
    .addStringOption((option) =>
      option
        .setName("대상")
        .setDescription("감지할 범프봇")
        .setRequired(true)
        .addChoices(
          { name: "디코보드", value: "discoboard" },
          { name: "DISBOARD", value: "disboard" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("공지채널")
    .setDescription("DIF 범프 안내를 보낼 채널을 설정합니다.")
    .addChannelOption((option) =>
      option
        .setName("채널")
        .setDescription("안내 메시지를 보낼 텍스트 채널")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("디프상태")
    .setDescription("이 서버의 DIF 설정과 범프 대기시간을 확인합니다."),
].map((command) => command.toJSON());

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bump_cooldowns (
      guild_id TEXT PRIMARY KEY,
      bumped_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      detector TEXT NOT NULL DEFAULT 'discoboard'
        CHECK (detector IN ('discoboard', 'disboard')),
      announcement_channel_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
    body: commands,
  });
  console.log("[DIF] 슬래시 명령어 등록 완료");
}

async function getSettings(guildId) {
  const result = await pool.query(
    `SELECT detector, announcement_channel_id
       FROM guild_settings
      WHERE guild_id = $1`,
    [guildId]
  );
  if (result.rowCount) return result.rows[0];

  const inserted = await pool.query(
    `INSERT INTO guild_settings (guild_id)
     VALUES ($1)
     ON CONFLICT (guild_id) DO UPDATE SET guild_id = EXCLUDED.guild_id
     RETURNING detector, announcement_channel_id`,
    [guildId]
  );
  return inserted.rows[0];
}

async function handleBump(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({
      content: "서버 안에서만 사용할 수 있는 명령어입니다.",
      ephemeral: true,
    });
  }

  const result = await pool.query(
    `INSERT INTO bump_cooldowns (guild_id, bumped_at)
     VALUES ($1, NOW())
     ON CONFLICT (guild_id) DO UPDATE
       SET bumped_at = NOW()
       WHERE bump_cooldowns.bumped_at <= NOW() - ($2 * INTERVAL '1 minute')
     RETURNING bumped_at`,
    [guildId, COOLDOWN_MINUTES]
  );

  if (result.rowCount === 0) {
    const previous = await pool.query(
      `SELECT GREATEST(
         0,
         CEIL(EXTRACT(EPOCH FROM
           (bumped_at + ($2 * INTERVAL '1 minute') - NOW())) / 60)
       )::int AS minutes_left
       FROM bump_cooldowns
       WHERE guild_id = $1`,
      [guildId, COOLDOWN_MINUTES]
    );
    const minutes = previous.rows[0]?.minutes_left ?? COOLDOWN_MINUTES;
    return interaction.reply({
      content: `아직 범프 대기시간이 남아 있습니다. 약 ${minutes}분 후 다시 시도해 주세요.`,
      ephemeral: true,
    });
  }

  const settings = await getSettings(guildId);
  if (settings.announcement_channel_id) {
    const channel = await interaction.guild.channels
      .fetch(settings.announcement_channel_id)
      .catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send(
        `📣 **${interaction.guild.name}** 서버가 DIF 범프를 실행했습니다!`
      ).catch((error) => console.error("[DIF] 안내 전송 실패:", error));
    }
  }

  return interaction.reply({
    content: "범프가 접수되었습니다. 이 서버의 다음 범프까지 120분의 대기시간이 적용됩니다.",
    ephemeral: true,
  });
}

client.once("ready", () => {
  console.log(`[DIF] 로그인 완료: ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "범프") {
      await handleBump(interaction);
      return;
    }

    if (!interaction.guildId) {
      return interaction.reply({
        content: "서버 안에서만 사용할 수 있는 명령어입니다.",
        ephemeral: true,
      });
    }

    if (interaction.commandName === "감지설정") {
      const detector = interaction.options.getString("대상", true);
      await pool.query(
        `INSERT INTO guild_settings (guild_id, detector, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE
           SET detector = EXCLUDED.detector, updated_at = NOW()`,
        [interaction.guildId, detector]
      );
      const label = detector === "discoboard" ? "디코보드" : "DISBOARD";
      return interaction.reply({
        content: `외부 범프 감지 대상으로 **${label}**을(를) 설정했습니다.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "공지채널") {
      const channel = interaction.options.getChannel("채널", true);
      await pool.query(
        `INSERT INTO guild_settings (guild_id, announcement_channel_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE
           SET announcement_channel_id = EXCLUDED.announcement_channel_id,
               updated_at = NOW()`,
        [interaction.guildId, channel.id]
      );
      return interaction.reply({
        content: `범프 안내 채널을 ${channel}로 설정했습니다.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "디프상태") {
      const settings = await getSettings(interaction.guildId);
      const cooldown = await pool.query(
        `SELECT GREATEST(
           0,
           CEIL(EXTRACT(EPOCH FROM
             (bumped_at + ($2 * INTERVAL '1 minute') - NOW())) / 60)
         )::int AS minutes_left
         FROM bump_cooldowns
         WHERE guild_id = $1`,
        [interaction.guildId, COOLDOWN_MINUTES]
      );
      const left = cooldown.rows[0]?.minutes_left ?? 0;
      const detectorName =
        settings.detector === "discoboard" ? "디코보드" : "DISBOARD";
      return interaction.reply({
        content:
          `**DIF 서버 설정**\n` +
          `감지 대상: ${detectorName}\n` +
          `안내 채널: ${
            settings.announcement_channel_id
              ? `<#${settings.announcement_channel_id}>`
              : "미설정"
          }\n` +
          `범프 대기시간: ${left > 0 ? `${left}분 남음` : "대기시간 없음"}`,
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error("[DIF] 명령어 처리 오류:", error);
    const message = {
      content: "명령어 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
});

async function shutdown(signal) {
  console.log(`[DIF] ${signal} 수신, 종료 중...`);
  client.destroy();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

(async () => {
  try {
    await initializeDatabase();
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error("[DIF] 시작 실패:", error);
    process.exit(1);
  }
})();
