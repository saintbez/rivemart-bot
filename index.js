require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

const orders = new Map();

/* ---------------- HELPERS ---------------- */

function normalizeMoney(cents) {
  if (cents === undefined || cents === null || isNaN(cents)) return "0.00";
  return (Number(cents) / 100).toFixed(2);
}

function maskEmail(email) {
  if (!email || !email.includes("@")) return "Hidden";
  const [n, d] = email.split("@");
  return `${n.slice(0, 3)}***@${d}`;
}

function generateToken(orderId) {
  return crypto
    .createHmac("sha256", process.env.RECEIPT_SECRET)
    .update(orderId)
    .digest("hex");
}

/* ---------------- DISCORD ---------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

/* ---------------- WEBHOOK ---------------- */

app.post("/sellapp-webhook", async (req, res) => {
  try {
    console.log("📦 FULL WEBHOOK DATA:", JSON.stringify(req.body, null, 2));
    
    const { event, data } = req.body;

    if (!["order.completed", "order.paid"].includes(event)) {
      return res.json({ ignored: true });
    }

    const orderId = String(data.id);
    const variant = data.product_variants?.[0] || {};

    const product = variant.product_title || "Unknown Product";
    const quantity = variant.quantity || 1;

    // 🔧 FIX: Extract Roblox username from additional_information by checking the LABEL
    let roblox = "Not provided";
    if (variant.additional_information && Array.isArray(variant.additional_information)) {
      const robloxField = variant.additional_information.find(f =>
        f.label && f.label.toLowerCase().includes("roblox")
      );
      if (robloxField && robloxField.value) {
        roblox = robloxField.value;
      }
    }

    const email = data.customer_information?.email || "Hidden";
    const country = data.customer_information?.country || "Unknown";

    // 🔧 FIX: Extract Discord username from discord_data.username
    let discordUser = "Not provided";
    if (data.customer_information?.discord_data?.username) {
      discordUser = data.customer_information.discord_data.username;
    }

    const coupon = data.coupon_id ? 
      variant.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon")?.attributes?.code || "Used" 
      : "None";

    // 🔧 FIX: Use gross_sale for the actual product price (before discounts)
    const grossSaleGBP = variant.invoice_payment?.payment_details?.gross_sale || 
                         data.payment?.full_price?.base || 
                         "0";
    
    const totalGBP = normalizeMoney(grossSaleGBP);

    // Convert to USD using exchange rate
    const exchangeRate = parseFloat(variant.invoice_payment?.exchange_rate || data.payment?.total?.exchange_rate || 1);
    const totalUSD = (parseFloat(totalGBP) * exchangeRate).toFixed(2);

    const status = "✅ Paid";
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

    console.log("✅ Order processed:", {
      orderId,
      product,
      roblox,
      discordUser,
      totalUSD,
      totalGBP
    });

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setTitle("🛒 New Order Received")
      .addFields(
        { name: "📦 Product", value: product },
        { name: "🔢 Quantity", value: String(quantity), inline: true },
        { name: "💷 Total (GBP)", value: `£${totalGBP}`, inline: true },
        { name: "💵 Total (USD)", value: `$${totalUSD}`, inline: true },
        { name: "🏷 Coupon", value: coupon },
        { name: "🎮 Roblox Username", value: roblox, inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "💳 Payment Status", value: status },
        { name: "🆔 Order ID", value: orderId },
        { name: "⏰ Order Time (UTC)", value: createdAt }
      )
      .setFooter({ text: "RiveMart • Automated Order System" })
      .setTimestamp();

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) {
      await channel.send({ embeds: [embed] });
      console.log("✅ Discord message sent");
    } else {
      console.error("❌ Discord channel not found");
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

/* ---------------- SUCCESS ---------------- */

app.get("/success", (req, res) => {
  const order = req.query.order;
  const record = orders.get(order);
  if (!record) return res.send("Order not found.");
  res.redirect(`/receipt?order=${order}&token=${record.token}`);
});

/* ---------------- RECEIPT ---------------- */

app.get("/receipt", (req, res) => {
  const { order, token } = req.query;
  const r = orders.get(order);

  if (!r || r.token !== token) {
    return res.status(403).send("Unauthorized");
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>RiveMart Receipt</title>
<style>
body {
  background:#f6f7fb;
  font-family:Arial;
  display:flex;
  justify-content:center;
  padding:40px;
}
.card {
  background:white;
  padding:30px;
  width:460px;
  border-radius:14px;
  box-shadow:0 10px 30px rgba(0,0,0,.1);
}
h1 { color:black; }
.info-row {
  display:flex;
  justify-content:space-between;
  padding:8px 0;
  border-bottom:1px solid #f0f0f0;
}
.info-label {
  font-weight:bold;
  color:#555;
}
.info-value {
  color:#222;
}
.box {
  background:#f1f5ff;
  padding:15px;
  border-radius:10px;
  margin-top:15px;
}
.delivery {
  background:#eefaf3;
  border-left:5px solid #3cb371;
}
</style>
</head>
<body>
<div class="card">
<h1>✅ Purchase Confirmed</h1>

<div class="info-row">
  <span class="info-label">Order ID:</span>
  <span class="info-value">${r.orderId}</span>
</div>
<div class="info-row">
  <span class="info-label">Product:</span>
  <span class="info-value">${r.product}</span>
</div>
<div class="info-row">
  <span class="info-label">Quantity:</span>
  <span class="info-value">${r.quantity}</span>
</div>
<div class="info-row">
  <span class="info-label">Roblox Username:</span>
  <span class="info-value">${r.roblox}</span>
</div>
<div class="info-row">
  <span class="info-label">Discord:</span>
  <span class="info-value">${r.discordUser}</span>
</div>
<div class="info-row">
  <span class="info-label">Email:</span>
  <span class="info-value">${maskEmail(r.email)}</span>
</div>
<div class="info-row">
  <span class="info-label">Country:</span>
  <span class="info-value">${r.country}</span>
</div>
<div class="info-row">
  <span class="info-label">Total Paid:</span>
  <span class="info-value">£${r.totalGBP} / $${r.totalUSD}</span>
</div>

<div class="box delivery">
<b>🚚 Delivery Information</b>
<p>
Our staff will message you via Discord to deliver your product.
Please ensure your DMs are open and you have joined the RiveMart server.
</p>
</div>
</div>
</body>
</html>
`);
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});