require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// Store orders in memory
const orders = new Map();

// -------- Discord Setup --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// -------- Webhook Handling --------
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;

    console.log("📦 Webhook received:", event);

    // Only handle payment/complete state
    if (event !== "order.paid" && event !== "order.completed") {
      return res.json({ message: "Ignored (not paid/completed)" });
    }

    // Save order details in memory
    const orderId = data.id.toString();
    const product = data.product_variants?.[0]?.product_title || "Unknown product";
    const robloxInfo = data.product_variants?.[0]?.additional_information?.find(f =>
      f.key.toLowerCase().includes("roblox")
    )?.value || "Not provided";
    const email = data.customer_information?.email || "Unknown";

    orders.set(orderId, {
      product,
      roblox: robloxInfo,
      email
    });

    // Send to Discord
    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) {
      channel.send(
        `🛒 **New Order**
**Product:** ${product}
**Email:** ${email}
**Roblox:** ${robloxInfo}
**Order ID:** ${orderId}`
      );
    }

    return res.json({ message: "OK" });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    return res.json({ message: "Error" });
  }
});

// -------- Success Page --------
app.get("/success", (req, res) => {
  const orderId = req.query.order;

  if (!orderId) {
    return res.send("No order ID provided.");
  }

  const order = orders.get(orderId);

  if (!order) {
    return res.send("Order not found — it may not have been processed yet.");
  }

  const joinDiscordURL = "https://discord.com/invite/PRmy2F3gAp";
  const openTicketURL = "https://discord.com/channels/1457151716238561321"; // If you want a direct link to a support channel

  res.send(`
    <html>
      <head><title>Order Receipt</title></head>
      <body style="font-family:Arial;text-align:center;padding:40px;">
        <h1>✅ Order Receipt</h1>

        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Product:</strong> ${order.product}</p>
        <p><strong>Roblox Username:</strong> ${order.roblox}</p>
        <p><strong>Email:</strong> ${order.email}</p>

        <hr style="margin-top:30px;margin-bottom:30px;">

        <a href="${joinDiscordURL}" style="display:inline-block;padding:12px 24px;margin:8px;background:#5865F2;color:white;border-radius:6px;text-decoration:none;font-weight:bold;">Join Discord</a>

        <a href="${openTicketURL}" style="display:inline-block;padding:12px 24px;margin:8px;background:#2F3136;color:white;border-radius:6px;text-decoration:none;font-weight:bold;">Open Support Ticket</a>

        <p style="margin-top:30px;color:#888;">If you don’t see your order here immediately, try refreshing after a few moments.</p>
      </body>
    </html>
  `);
});

// -------- Start Server --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
