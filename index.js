require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// =======================
// In-memory order store
// =======================
const orders = new Map();

// =======================
// Discord Client
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// =======================
// Helpers
// =======================
function maskEmail(email) {
  if (!email || !email.includes("@")) return "Unknown";
  const [name, domain] = email.split("@");
  return name.slice(0, 3) + "***@" + domain;
}

function formatMoney(amount, currency) {
  if (!amount) return "0.00";
  return (Number(amount) / 100).toFixed(2) + " " + currency;
}

function generateToken(orderId) {
  return crypto
    .createHmac("sha256", process.env.RECEIPT_SECRET)
    .update(orderId)
    .digest("hex");
}

// =======================
// SellApp Webhook
// =======================
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log("📦 Webhook received:", event);

    // Accept paid OR completed
    if (!["order.paid", "order.completed"].includes(event)) {
      return res.json({ message: "Ignored" });
    }

    const orderId = String(data.id);

    const variant = data.product_variants?.[0];
    const product = variant?.product_title || "Unknown";
    const quantity = variant?.quantity || 1;

    const roblox =
      variant?.additional_information?.find(v =>
        v.label?.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "Unknown";
    const country = data.customer_information?.country || "Unknown";
    const discordUser = data.customer_information?.discord_data?.username || "Not linked";

    const coupon =
      variant?.invoice_payment?.payment_details?.modifications?.[0]?.attributes?.code ||
      "None";

    const totalGBP = data.payment?.full_price?.base;
    const totalUSD = data.payment?.total?.gross_sale_usd;

    const createdAt = new Date(data.created_at).toUTCString();

    const token = generateToken(orderId);

    // Store order securely
    orders.set(orderId, {
      orderId,
      product,
      quantity,
      roblox,
      email,
      country,
      discordUser,
      coupon,
      totalGBP,
      totalUSD,
      createdAt,
      token,
      paid: true
    });

    // =======================
    // Discord Embed
    // =======================
    const embed = new EmbedBuilder()
      .setTitle("🛒 New Order Received")
      .setColor(0x5865f2)
      .addFields(
        { name: "📦 Product", value: product, inline: true },
        { name: "🔢 Quantity", value: String(quantity), inline: true },
        { name: "💷 Total (GBP)", value: "£" + formatMoney(totalGBP, "GBP"), inline: true },
        { name: "💵 Total (USD)", value: "$" + formatMoney(totalUSD, "USD"), inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "🎮 Roblox Username", value: roblox, inline: true },
        { name: "📧 Email", value: maskEmail(email), inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "💳 Payment Status", value: "✅ Paid", inline: true },
        { name: "🆔 Order ID", value: orderId, inline: true },
        { name: "⏰ Order Time (UTC)", value: createdAt }
      )
      .setFooter({ text: "RiveMart • Automated Order System" });

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) await channel.send({ embeds: [embed] });

    return res.json({ message: "OK" });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.json({ message: "Handled with error" });
  }
});

// =======================
// Secure Receipt Page
// =======================
app.get("/success", (req, res) => {
  const { order, token } = req.query;
  if (!order || !token) {
    return res.status(403).send("Invalid receipt link.");
  }

  const record = orders.get(order);
  if (!record) {
    return res.status(404).send("Order not found.");
  }

  if (record.token !== token) {
    return res.status(403).send("Unauthorized receipt access.");
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>RiveMart Receipt</title>
<style>
body {
  background:#0e0e10;
  color:#fff;
  font-family:Arial;
  display:flex;
  justify-content:center;
}
.card {
  background:#1e1f22;
  padding:30px;
  border-radius:12px;
  width:420px;
}
h1 { color:#57f287; }
hr { border:1px solid #333; }
.btn {
  display:inline-block;
  margin-top:12px;
  padding:12px 18px;
  background:#5865F2;
  color:white;
  text-decoration:none;
  border-radius:6px;
}
</style>
</head>
<body>
<div class="card">
<h1>✅ Purchase Confirmed</h1>
<p><b>Order ID:</b> ${record.orderId}</p>
<p><b>Product:</b> ${record.product}</p>
<p><b>Quantity:</b> ${record.quantity}</p>
<p><b>Roblox:</b> ${record.roblox}</p>
<p><b>Email:</b> ${maskEmail(record.email)}</p>
<p><b>Country:</b> ${record.country}</p>
<p><b>Total:</b> £${formatMoney(record.totalGBP, "GBP")}</p>
<hr>
<a class="btn" href="https://discord.gg/PRmy2F3gAp">Join Discord</a>
</div>
</body>
</html>
`);
});

// =======================
// Start Server
// =======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
