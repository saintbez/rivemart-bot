require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// ==================
// In-memory order store
// ==================
const orders = new Map();

// ==================
// Helpers
// ==================
function formatMoney(amount, symbol) {
  if (!amount) return `${symbol}0.00`;
  return `${symbol}${(Number(amount) / 100).toFixed(2)}`;
}

// ==================
// Discord Client
// ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// ==================
// SellApp Webhook
// ==================
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log("📦 Webhook received:", event);

    if (event !== "order.paid" && event !== "order.completed") {
      return res.json({ message: "Ignored" });
    }

    const orderId = data.id.toString();
    const variant = data.product_variants?.[0] || {};
    const payment = variant.invoice_payment?.payment_details || {};

    const product = variant.product_title || "Unknown";
    const quantity = payment.quantity || 1;

    const totalGBP = formatMoney(payment.gross_sale, "£");
    const totalUSD = formatMoney(data.payment?.total?.gross_sale_usd, "$");

    const coupon =
      payment.modifications?.find(m => m.type === "coupon")
        ? payment.modifications[0]?.attributes?.code || "Applied"
        : "None";

    const roblox =
      variant.additional_information?.find(f =>
        f.label?.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "Unknown";
    const country = data.customer_information?.country || "Unknown";

    const discordUser =
      data.customer_information?.discord_data?.username
        ? data.customer_information.discord_data.username
        : "Not linked";

    const paid =
      data.status?.status?.status === "COMPLETED" ||
      data.payment?.total?.total_usd === "0";

    const orderTime = new Date(data.created_at);

    orders.set(orderId, {
      product,
      quantity,
      totalGBP,
      totalUSD,
      coupon,
      roblox,
      email,
      country,
      discordUser,
      paid,
      orderTime
    });

    // ==================
    // Discord Embed
    // ==================
    const embed = new EmbedBuilder()
      .setTitle("🛒 New Order Received")
      .setColor(paid ? 0x57F287 : 0xFAA61A)
      .addFields(
        { name: "📦 Product", value: product, inline: false },
        { name: "🔢 Quantity", value: String(quantity), inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "💷 Total (GBP)", value: totalGBP, inline: true },
        { name: "💵 Total (USD)", value: totalUSD, inline: true },
        { name: "🎮 Roblox Username", value: roblox, inline: false },
        { name: "📧 Email", value: email, inline: false },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "💳 Payment Status", value: paid ? "✅ Paid" : "⏳ Pending", inline: true },
        { name: "🆔 Order ID", value: orderId, inline: false }
      )
      .setTimestamp(orderTime)
      .setFooter({ text: "RiveMart • Automated Order System" });

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }

    res.json({ message: "OK" });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ message: "Error" });
  }
});

// ==================
// Success Page
// ==================
app.get("/success", (req, res) => {
  const orderId = req.query.order;
  if (!orderId || !orders.has(orderId)) {
    return res.send("❌ Order not found.");
  }

  const o = orders.get(orderId);

  res.send(`
  <html>
    <body style="font-family:Arial;text-align:center;padding:40px;">
      <h1>✅ Purchase Successful</h1>
      <p><strong>Order ID:</strong> ${orderId}</p>
      <p><strong>Product:</strong> ${o.product}</p>
      <p><strong>Quantity:</strong> ${o.quantity}</p>
      <p><strong>Total:</strong> ${o.totalGBP} (${o.totalUSD})</p>
      <p><strong>Roblox Username:</strong> ${o.roblox}</p>
      <p><strong>Email:</strong> ${o.email}</p>
      <p><strong>Order Time:</strong> ${o.orderTime.toUTCString()}</p>

      <a href="https://discord.com/invite/PRmy2F3gAp">Join Discord</a>
    </body>
  </html>
  `);
});

// ==================
// Start Server
// ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
