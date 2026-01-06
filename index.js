const dotenv = require('dotenv');
dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // untuk development dengan sertifikat self-signed

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// models
const AfkUser = require('./models/afkUser');

// auto-message modules (tetap di sini sebagai require)
const autoChat = require('./auto-message/auto-chat.js');
const welcomer = require('./auto-message/welcomer.js');

// 💡 PENAMBAHAN INTI 1: Import Reminder Scheduler
const startReminderScheduler = require('./node-cron-main/reminder-scheduler.js');

// 📂 IMPORT ADMIN HANDLER (Untuk Clear DB Rahasia)
const adminHandler = require('./admin_command/delete-db.js');

// Connect ke MongoDB (jika MONGO_URI ada)
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }).then(() => {
    console.log('✅ Connected to MongoDB!');
  }).catch(err => {
    console.error('❌ MongoDB connection error:', err);
  });
} else {
  console.warn('⚠️ MONGO_URI tidak ditemukan di .env — melewati koneksi MongoDB.');
}
// ----------------------------------------------------

// --- DEKLARASI CLIENT (WAJIB DISINI) ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();
client.afkUsers = new Collection(); // cache lokal AFK
// ----------------------------------------

// --- LOAD ROLE MANAGEMENT MODULES (Pindah ke sini) ---
try {
  require('./role-management/role-protection.js')(client);
  require('./role-management/role-auto-remove.js')(client);
  console.log('✅ Role management modules loaded.');
} catch (err) {
  // Memberikan pesan error yang lebih jelas
  console.error(`❌ Gagal memuat modul role management: ${err.message}. Pastikan file diekspor dengan 'module.exports = (client) => { ... }'`);
}
// ----------------------------------------------------

// Helper: load commands recursively (scan folder command dan subfolder)
function loadCommandsRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      loadCommandsRecursive(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      try {
        delete require.cache[require.resolve(full)];
      } catch (_) { }
      const command = require(full);
      if (command && command.data && command.execute) {
        client.commands.set(command.data.name, command);
        console.log(`Perintah ${command.data.name} berhasil dimuat dari ${full}.`);
      } else {
        console.log(`[WARNING] Perintah di ${full} tidak memiliki properti "data" atau "execute" yang dibutuhkan.`);
      }
    }
  }
}

// load semua command dari folder ./command (rekursif)
const commandsPath = path.join(__dirname, 'command');
if (fs.existsSync(commandsPath)) {
  loadCommandsRecursive(commandsPath);
}

// Ready event
client.on('ready', async () => {
  console.log(`logged in as ${client.user.tag}`);

  // presence
  client.user.setPresence({
    activities: [{ name: 'Kimkir Impact', type: 0 }],
    status: 'idle'
  });

  // Muat AFK dari MongoDB ke cache (jika connected)
  try {
    const allAfk = await AfkUser.find({});
    for (const doc of allAfk) {
      client.afkUsers.set(`${doc.guildId}-${doc.userId}`, {
        reason: doc.reason,
        timestamp: doc.timestamp,
        originalNickname: doc.originalNickname
      });
    }
    console.log(`Loaded ${allAfk.length} AFK entries into cache.`);
  } catch (err) {
    console.error('Gagal load AFK dari MongoDB:', err);
  }

  // 💡 PENAMBAHAN INTI 2: Jalankan Reminder Scheduler
  startReminderScheduler(client);

  autoChat(client);
  welcomer(client);
});

// Interaction handling (slash commands)
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Ada kesalahan bg saat jalanin perintah :v', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Ada kesalahan bg saat jalanin perintah :v', ephemeral: true });
      }
    } catch (_) { }
  }
});

// messageCreate untuk AFK handling & Admin Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // 🛠️ ADMIN HANDLER (Gunakan Prefix Kustom di file delete-db.js)
  await adminHandler(message, client);

  const key = `${message.guild.id}-${message.author.id}`;
  const afkInfo = client.afkUsers.get(key);

  // user kembali: hapus cache & DB, restore nickname
  if (afkInfo) {
    client.afkUsers.delete(key);
    try {
      await AfkUser.deleteOne({ guildId: message.guild.id, userId: message.author.id });
    } catch (err) {
      console.error('Gagal hapus AFK dari DB:', err);
    }

    try {
      await message.member.setNickname(afkInfo.originalNickname);
    } catch (error) {
      console.log('Gagal balikin nickname:', error);
    }

    const reply = await message.reply('Welkam back! Status AFK luwh udah dihapus.');
    setTimeout(() => reply.delete().catch(e => console.error("Gagal hapus pesan 'welcome back':", e)), 10000);
  }

  // cek mention apakah mention user AFK
  message.mentions.users.forEach(user => {
    const afkMentioned = client.afkUsers.get(`${message.guild.id}-${user.id}`);
    if (afkMentioned) {
      message.reply(`<:arrow2:1414259950191906999> **${user.username}** lagi AFK\n<:blank:1271074823552110676> **Alasan:** ${afkMentioned.reason}`);
    }
  });
});

// graceful shutdown
process.on('SIGINT', async () => {
  console.log('SIGINT received — closing client & mongoose.');
  try { await client.destroy(); } catch (_) { }
  try { await mongoose.disconnect(); } catch (_) { }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);

// ------------------ END OF INDEX.JS ------------------ //