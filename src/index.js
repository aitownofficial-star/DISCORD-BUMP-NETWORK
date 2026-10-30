const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");
const { Pool } = require("pg");
const express = require("express");
const path = require("path");

const web = express();
const PORT = Number(process.env.PORT) || 10000;

web.use(express.static(path.join(__dirname, "..", "public")));
web.get("/", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
web.get("/api/stats", async (_req, res) => {
  try {
    const totals = await pool.query("SELECT COUNT(DISTINCT guild_id)::int AS server_count, COUNT(*)::int AS bump_count, COUNT(*) FILTER (WHERE bumped_at >= NOW() - INTERVAL '1 day')::int AS recent_count FROM bump_events");
    const servers = await pool.query("SELECT e.guild_id AS id, MAX(e.guild_name) AS name, COUNT(*)::int AS bump_count, MAX(e.bumped_at) AS last_bump_at, MAX(gs.invite_url) AS invite_url FROM bump_events e LEFT JOIN guild_settings gs ON gs.guild_id = e.guild_id GROUP BY e.guild_id ORDER BY MAX(e.bumped_at) DESC LIMIT 100");
    res.json({ serverCount: totals.rows[0].server_count, bumpCount: totals.rows[0].bump_count, recentCount: totals.rows[0].recent_count, servers: servers.rows.map((s) => ({ id: s.id, name: s.name, bumpCount: s.bump_count, lastBumpAt: s.last_bump_at, inviteUrl: s.invite_url })) });
  } catch (error) { console.error("[DIF] 통계 조회 오류:", error); res.status(503).json({ error: "통계를 불러올 수 없습니다." }); }
});

web.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "DIF",
    bot: client.isReady() ? "online" : "offline",
    gatewayStatus: client.ws.status,
    ping: client.ws.ping,
  });
});

web.listen(PORT, "0.0.0.0", () => {
  console.log(`[DIF] HTTP server listening on port ${PORT}`);
});

// Render에 배포된 사이트의 상태 확인 엔드포인트를 10분마다 호출합니다.
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/health`
  : "https://discord-bump-network.onrender.com/health";

async function selfPing() {
  try {
    const response = await fetch(SELF_PING_URL);
    console.log(`[DIF] 10분 주기 사이트 핑: HTTP ${response.status}`);
  } catch (error) {
    console.error("[DIF] 사이트 핑 실패:", error.message);
  }
}

setInterval(selfPing, 10 * 60 * 1000);


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
    CREATE TABLE IF NOT EXISTS bump_events (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      guild_name TEXT NOT NULL,
      source TEXT NOT NULL,
      bumped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      detector TEXT NOT NULL DEFAULT 'discoboard'
        CHECK (detector IN ('discoboard', 'disboard')),
      announcement_channel_id TEXT,
      invite_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS invite_url TEXT");
}

async function getOrCreateServerInvite(guild, preferredChannelId) {
  const settings = await getSettings(guild.id);
  if (settings.invite_url) return settings.invite_url;

  let channel = preferredChannelId
    ? await guild.channels.fetch(preferredChannelId).catch(() => null)
    : null;
  if (!channel?.isTextBased() || !channel?.createInvite) {
    channel = guild.systemChannel?.isTextBased() ? guild.systemChannel : null;
  }
  if (!channel?.createInvite) {
    channel = guild.channels.cache.find((item) =>
      item.isTextBased() && item.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)
    ) || null;
  }
  if (!channel) {
    console.warn("[DIF] 초대 링크를 만들 수 있는 채널이 없습니다:", guild.id);
    return null;
  }

  const invite = await channel.createInvite({
    maxAge: 0,
    maxUses: 0,
    unique: false,
    reason: "DIF 네트워크 서버 공개 초대 링크",
  }).catch((error) => {
    console.error("[DIF] 초대 링크 생성 실패:", error);
    return null;
  });
  if (!invite) return null;

  await pool.query(
    "UPDATE guild_settings SET invite_url = $2, updated_at = NOW() WHERE guild_id = $1",
    [guild.id, invite.url]
  );
  return invite.url;
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
      embeds: [new EmbedBuilder().setColor(0x6c9cff).setDescription("서버 안에서만 사용할 수 있는 명령어입니다.")],
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
      embeds: [new EmbedBuilder().setColor(0xffb454).setTitle("⏳ 범프 대기시간").setDescription(`약 ${minutes}분 후 다시 시도해 주세요.`).setFooter({ text: "DIF — Discord Bump Network" })],
    });
  }

  const settings = await getSettings(guildId);
  if (settings.announcement_channel_id) {
    const channel = await interaction.guild.channels
      .fetch(settings.announcement_channel_id)
      .catch(() => null);
    if (channel?.isTextBased()) {
      const embed = new EmbedBuilder().setColor(0x69ddeb).setTitle("🧡 DIF 범프 실행").setDescription("**" + interaction.guild.name + "** 서버에서 DIF 범프가 실행되었습니다.").setTimestamp().setFooter({ text: "DIF — Discord Bump Network" });
      await channel.send({ embeds: [embed] }).catch((error) => console.error("[DIF] 공개 Embed 전송 실패:", error));
    }
  }

  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x69ddeb).setTitle("🧡 DIF 범프 접수 완료").setDescription("범프가 접수되었습니다. 다음 범프까지 120분의 대기시간이 적용됩니다.").setFooter({ text: "DIF — Discord Bump Network" })],
  });
}

const BUMP_BOTS = { "302050872383242240": "DISBOARD", "1467542161548382414": "디코리스트" };
const AUTO_BUMP_USER_ID = "1252620171089019021";
function containsBumpKeyword(message) {
  const parts = [message.content || ""];
  for (const embed of message.embeds) {
    parts.push(embed.title || "", embed.description || "");
    for (const field of embed.fields || []) parts.push(field.name || "", field.value || "");
  }
  return /(갱신|범프)/i.test(parts.join(" "));
}

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || !message.author) return;
    if (message.author.id === client.user.id) return;

    // 지정된 사람 계정은 쿨타임 없이 범프 키워드를 감지합니다.
    if (message.author.id === AUTO_BUMP_USER_ID && !/(갱신|범프)/i.test(message.content || "")) return;

    // 메시지 본문 또는 Embed에서 범프/갱신 키워드를 감지합니다.
    if (message.author.id !== AUTO_BUMP_USER_ID && !containsBumpKeyword(message)) return;

    const isTrustedUser = message.author.id === AUTO_BUMP_USER_ID;
    const sourceName = isTrustedUser
      ? "지정 사용자 자동 범프"
      : (BUMP_BOTS[message.author.id]
          || (message.author.bot ? `봇: ${message.author.username}` : `사용자: ${message.author.username}`));

    const saved = await pool.query(
      "INSERT INTO bump_events (guild_id, guild_name, source) VALUES ($1, $2, $3) RETURNING bumped_at",
      [message.guild.id, message.guild.name, sourceName]
    );
    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM bump_events WHERE guild_id = $1",
      [message.guild.id]
    );

    await message.react("🧡").catch((e) => console.error("[DIF] 반응 추가 실패:", e));

    // 공지 채널 설정과 관계없이 감지된 원본 메시지 채널에 Embed를 보냅니다.
    if (message.channel?.isTextBased() && message.channel.send) {
      const embed = new EmbedBuilder()
        .setColor(0x69ddeb)
        .setTitle("🧡 서버 범프 완료!")
        .setDescription(`**${message.guild.name}** 서버의 범프가 완료되었습니다.`)
        .addFields(
          { name: "감지 서비스", value: sourceName, inline: true },
          { name: "누적 감지 횟수", value: String(count.rows[0].n), inline: true },
          { name: "감지 채널", value: `<#${message.channel.id}>`, inline: true }
        )
        .setTimestamp(saved.rows[0].bumped_at)
        .setFooter({ text: "DIF — Discord Bump Network" });

      await message.channel.send({ embeds: [embed] }).catch((e) => {
        console.error("[DIF] 원본 채널 Embed 전송 실패:", e);
      });
    } else {
      console.warn("[DIF] 감지된 채널에 메시지를 보낼 수 없습니다:", message.channelId);
    }

    console.log("[DIF] " + message.guild.name + " 범프 키워드 감지 (" + sourceName + ")");
  } catch (error) {
    console.error("[DIF] 범프 감지 처리 오류:", error);
  }
});

client.once("ready", () => {
  console.log(`[DIF] 로그인 완료: ${client.user.tag}`);
  console.log(`[DIF] Gateway 상태: ${client.ws.status}, Ping: ${client.ws.ping}ms`);
});

// Discord Gateway 연결 상태 추적
client.on("error", (error) => {
  console.error("[DIF] Discord 클라이언트 오류:", error);
});

client.on("shardError", (error, shardId) => {
  console.error(`[DIF] Gateway Shard ${shardId} 오류:`, error);
});

client.on("shardDisconnect", (closeEvent, shardId) => {
  console.error(`[DIF] Gateway 연결 종료 (Shard ${shardId}):`, {
    code: closeEvent.code,
    reason: closeEvent.reason || "사유 없음",
    wasClean: closeEvent.wasClean,
  });
});

client.on("shardReconnecting", (shardId) => {
  console.warn(`[DIF] Gateway 재연결 시도 중 (Shard ${shardId})`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  console.log(`[DIF] Gateway 연결 복구 (Shard ${shardId}), 재생 이벤트: ${replayedEvents}`);
});

client.on("invalidated", () => {
  console.error("[DIF] Discord 세션이 무효화되었습니다. 토큰 또는 세션 상태를 확인해 주세요.");
});

client.on("warn", (warning) => {
  console.warn("[DIF] Discord 경고:", warning);
});

process.on("unhandledRejection", (reason) => {
  console.error("[DIF] 처리되지 않은 Promise 오류:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[DIF] 처리되지 않은 예외:", error);
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
        embeds: [new EmbedBuilder().setColor(0x6c9cff).setDescription("서버 안에서만 사용할 수 있는 명령어입니다.")],
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
        embeds: [new EmbedBuilder().setColor(0x69ddeb).setTitle("✅ 공지 채널 설정 완료").setDescription(`범프 안내 채널을 ${channel}로 설정했습니다.`).setFooter({ text: "DIF — Discord Bump Network" })],
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
      const statusEmbed = new EmbedBuilder()
        .setColor(0x69ddeb)
        .setTitle("📊 DIF 서버 상태")
        .addFields(
          { name: "감지 대상", value: "DISBOARD + 디코리스트 (갱신/범프 키워드)", inline: false },
          { name: "안내 채널", value: settings.announcement_channel_id ? `<#${settings.announcement_channel_id}>` : "미설정", inline: true },
          { name: "범프 대기시간", value: left > 0 ? `${left}분 남음` : "대기시간 없음", inline: true }
        )
        .setFooter({ text: "DIF — Discord Bump Network" });
      return interaction.reply({ embeds: [statusEmbed] });
    }
  } catch (error) {
    console.error("[DIF] 명령어 처리 오류:", error);
    const message = {
      embeds: [new EmbedBuilder().setColor(0xff6b6b).setTitle("명령어 처리 오류").setDescription("명령어 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.")],
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
