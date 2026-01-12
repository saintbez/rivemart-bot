require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// ------------------ MEMORY STORE ------------------
const orders = new Map();

// ------------------ HELPERS ------------------
function formatMoney(cents, currency) {
  if (!cents) return "0.00";
  return (cents / 100).toFixed(2);
}

function maskEmail(email) {
  if (!email || !email.includes("@")) return "Hidden";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 3)}***@${domain}`;
}

function generateToken(orderId) {
  return crypto
    .createHmac("sha256", process.env.RECEIPT_SECRET)
    .update(orderId)
    .digest("hex");
}

// ------------------ DISCORD ------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// ------------------ SELLAPP WEBHOOK ------------------
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;

    if (!["order.paid", "order.completed"].includes(event)) {
      return res.json({ ignored: true });
    }

    const orderId = data.id.toString();
    const variant = data.product_variants?.[0] || {};

    const product = variant.product_title || "Unknown Product";
    const quantity = variant.quantity || 1;

    const roblox =
      variant.additional_information?.find(f =>
        f.key.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "Hidden";
    const country = data.customer_information?.country || "Unknown";
    const discordUser =
      data.customer_information?.discord_username || "Not provided";

    const coupon =
      data.coupon?.code || "None";

    const totalUSD = data.price?.total || 0;
    const totalGBP = data.price?.total_gbp || 0;

    const status =
      data.status === "paid" ? "✅ Paid" : "⏳ Pending";

    const createdAt = new Date(data.created_at).toUTCString();

    const token = generateToken(orderId);

    orders.set(orderId, {
      orderId,
      product,
      quantity,
      roblox,
      email,
      country,
      discordUser,
      coupon,
      totalUSD,
      totalGBP,
      status,
      createdAt,
      token
    });

    const embed = new EmbedBuilder()
      .setColor("#57F287")
      .setTitle("🛒 New Order Received")
      .addFields(
        { name: "📦 Product", value: product, inline: false },
        { name: "🔢 Quantity", value: `${quantity}`, inline: true },
        { name: "💷 Total (GBP)", value: `£${formatMoney(totalGBP)}`, inline: true },
        { name: "💵 Total (USD)", value: `$${formatMoney(totalUSD)}`, inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "🎮 Roblox Username", value: roblox, inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "💳 Payment Status", value: status, inline: true },
        { name: "🆔 Order ID", value: orderId, inline: false },
        { name: "⏰ Order Time (UTC)", value: createdAt, inline: false }
      )
      .setFooter({ text: "RiveMart • Automated Order System" })
      .setTimestamp();

    const channel = await client.channels.fetch(
      process.env.ORDER_CHANNEL_ID
    );
    if (channel) channel.send({ embeds: [embed] });

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// ------------------ SUCCESS REDIRECT ------------------
app.get("/success", (req, res) => {
  const { order } = req.query;
  if (!order) return res.send("Missing order.");

  const record = orders.get(order);
  if (!record) return res.send("Order not found.");

  return res.redirect(`/receipt?order=${order}&token=${record.token}`);
});

// ------------------ LOCKED RECEIPT ------------------
app.get("/receipt", (req, res) => {
  const { order, token } = req.query;

  const record = orders.get(order);
  if (!record || record.token !== token) {
    return res.status(403).send("Unauthorized receipt access.");
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>RiveMart Receipt</title>
<style>
body {
  background:#0b0c10;
  color:#fff;
  font-family:Arial, sans-serif;
  display:flex;
  justify-content:center;
  padding:40px;
}
.card {
  background:#1f2833;
  padding:30px;
  border-radius:14px;
  width:420px;
}
h1 {
  color:#66fcf1;
}
hr {
  border:1px solid #333;
}
</style>
</head>
<body>
<div class="card">
<h1>✅ Purchase Confirmed</h1>
<hr>
<p><b>Order ID:</b> ${record.orderId}</p>
<p><b>Product:</b> ${record.product}</p>
<p><b>Quantity:</b> ${record.quantity}</p>
<p><b>Roblox:</b> ${record.roblox}</p>
<p><b>Email:</b> ${maskEmail(record.email)}</p>
<p><b>Country:</b> ${record.country}</p>
<p><b>Total:</b> £${formatMoney(record.totalGBP)}</p>
</div>
</body>
</html>
`);
});

// ------------------ SERVER ------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
