require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// --------------------
// In-memory order store
// --------------------
const orders = new Map();

// --------------------
// Discord Setup
// --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
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
    const payload = req.body;
    const { event, data } = payload;

    console.log("📦 Webhook received:", event);

    // ✅ Treat order.paid as completed (SellApp change)
    const isPaid =
      event === "order.paid" ||
      data?.status?.status?.status === "COMPLETED";

    if (!isPaid) {
      return res.json({ ignored: true });
    }

    // --------------------
    // Extract Order Info
    // --------------------
    const orderId = String(data.id);

    const productName =
      data.product_variants?.[0]?.product_title || "Unknown Product";

    const email =
      data.customer_information?.email || "Unknown";

    const country =
      data.customer_information?.country || "Unknown";

    const discordUsername =
      data.customer_information?.discord_data?.username || "Not connected";

    // ✅ FIXED Roblox username extraction
    let robloxUsername = "Not provided";
    for (const variant of data.product_variants || []) {
      for (const info of variant.additional_information || []) {
        if (info.label?.toLowerCase().includes("roblox")) {
          robloxUsername = info.value;
          break;
        }
      }
    }

    // --------------------
    // Save for receipt page
    // --------------------
    orders.set(orderId, {
      product: productName,
      roblox: robloxUsername,
      email,
      country,
      discord: discordUsername,
      paid: true
    });

    // --------------------
    // Send Discord Embed
    // --------------------
    const channel = await client.channels.fetch(
      process.env.ORDER_CHANNEL_ID
    );

    if (channel) {
      await channel.send({
        embeds: [
          {
            title: "🛒 New Paid Order",
            color: 0x00ff99,
            fields: [
              { name: "📦 Product", value: productName, inline: false },
              { name: "🧾 Order ID", value: orderId, inline: true },
              { name: "💳 Status", value: "PAID ✅", inline: true },
              { name: "📧 Email", value: email, inline: false },
              { name: "🌍 Country", value: country, inline: true },
              { name: "🎮 Roblox", value: robloxUsername, inline: true },
              { name: "💬 Discord", value: discordUsername, inline: true }
            ],
            timestamp: new Date()
          }
        ]
      });
    }

    return res.json({ message: "OK" });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
});

// --------------------
// Success / Receipt Page
// --------------------
app.get("/success", (req, res) => {
  const orderId = req.query.order;

  if (!orderId) {
    return res.send("No order ID provided.");
  }

  const order = orders.get(orderId);

  if (!order) {
    return res.send("Order not found yet. Please refresh in a moment.");
  }

  const joinDiscordURL = "https://discord.com/invite/PRmy2F3gAp";
  const openTicketURL = "https://discord.com/channels/1457151716238561321";

  res.send(`
    <html>
      <head>
        <title>Order Receipt</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:40px;">
        <h1>✅ Order Receipt</h1>

        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Product:</strong> ${order.product}</p>
        <p><strong>Roblox Username:</strong> ${order.roblox}</p>
        <p><strong>Email:</strong> ${order.email}</p>
        <p><strong>Country:</strong> ${order.country}</p>
        <p><strong>Payment Status:</strong> PAID ✅</p>

        <hr style="margin:30px 0;">

        <a href="${joinDiscordURL}"
           style="display:inline-block;padding:12px 24px;margin:8px;
                  background:#5865F2;color:white;border-radius:6px;
                  text-decoration:none;font-weight:bold;">
          Join Discord
        </a>

        <a href="${openTicketURL}"
           style="display:inline-block;padding:12px 24px;margin:8px;
                  background:#2F3136;color:white;border-radius:6px;
                  text-decoration:none;font-weight:bold;">
          Open Support Ticket
        </a>

        <p style="margin-top:30px;color:#888;">
          Keep this page as your receipt.
        </p>
      </body>
    </html>
  `);
});

// --------------------
// Start Server
// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
