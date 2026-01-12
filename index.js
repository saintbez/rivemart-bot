require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// --------------------
// In-memory secure order store
// --------------------
const orders = new Map(); // orderId -> order data

// --------------------
// Discord Setup
// --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// --------------------
// SellApp Webhook
// --------------------
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;

    console.log("📦 Webhook received:", event);

    // ✅ Treat order.paid as completed (SellApp official guidance)
    const isPaid =
      event === "order.paid" ||
      data?.status?.status?.status === "COMPLETED";

    if (!isPaid) {
      return res.json({ ignored: true });
    }

    const orderId = String(data.id);

    // ❌ Prevent duplicate processing (fraud / resend safe)
    if (orders.has(orderId)) {
      return res.json({ message: "Already processed" });
    }

    // --------------------
    // Extract Order Data
    // --------------------
    const product =
      data.product_variants?.[0]?.product_title || "Unknown Product";

    const email =
      data.customer_information?.email || "Unknown";

    const country =
      data.customer_information?.country || "Unknown";

    const discordUserId =
      data.customer_information?.discord_data?.user_id || null;

    const discordUsername =
      data.customer_information?.discord_data?.username || "Not connected";

    // Roblox username (FIXED + REQUIRED SAFE)
    let roblox = "Not provided";
    for (const variant of data.product_variants || []) {
      for (const info of variant.additional_information || []) {
        if (info.label?.toLowerCase().includes("roblox")) {
          roblox = info.value;
        }
      }
    }

    // --------------------
    // Store order securely
    // --------------------
    orders.set(orderId, {
      product,
      email,
      country,
      roblox,
      discordUsername,
      paid: true,
      roleAssigned: false
    });

    // --------------------
    // Discord Notification
    // --------------------
    const channel = await client.channels.fetch(
      process.env.ORDER_CHANNEL_ID
    );

    if (channel) {
      await channel.send({
        embeds: [{
          title: "🛒 New Verified Purchase",
          color: 0x00ff99,
          fields: [
            { name: "Product", value: product },
            { name: "Order ID", value: orderId, inline: true },
            { name: "Status", value: "PAID ✅", inline: true },
            { name: "Email", value: email },
            { name: "Country", value: country, inline: true },
            { name: "Roblox", value: roblox, inline: true },
            { name: "Discord", value: discordUsername }
          ],
          timestamp: new Date()
        }]
      });
    }

    // --------------------
    // Role Assignment (ANTI-ABUSE)
    // --------------------
    if (discordUserId) {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const member = await guild.members.fetch(discordUserId).catch(() => null);

      if (member) {
        const roleId = "1457151716389687531"; // Verified Purchase role

        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId);
          orders.get(orderId).roleAssigned = true;
          console.log("✅ Role assigned");
        }
      }
    }

    return res.json({ message: "OK" });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
});

// --------------------
// Secure Receipt Page
// --------------------
app.get("/success", (req, res) => {
  const orderId = req.query.order;
  const order = orders.get(orderId);

  if (!order) {
    return res.send("❌ Order not found or not verified yet.");
  }

  res.send(`
    <html>
      <head><title>Order Receipt</title></head>
      <body style="font-family:Arial;text-align:center;padding:40px;">
        <h1>✅ Verified Purchase</h1>

        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Product:</strong> ${order.product}</p>
        <p><strong>Roblox Username:</strong> ${order.roblox}</p>
        <p><strong>Email:</strong> ${order.email}</p>
        <p><strong>Country:</strong> ${order.country}</p>
        <p><strong>Status:</strong> PAID ✅</p>

        <hr style="margin:30px">

        <a href="https://discord.com/invite/PRmy2F3gAp"
           style="padding:12px 24px;background:#5865F2;color:white;
                  border-radius:6px;text-decoration:none;font-weight:bold;">
          Join Discord
        </a>

        <p style="margin-top:30px;color:#888;">
          This receipt is server-verified and cannot be forged.
        </p>
      </body>
    </html>
  `);
});

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
