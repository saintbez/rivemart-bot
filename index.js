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

    // Extract Roblox username from additional_information by checking the LABEL
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

    // Extract Discord username from discord_data.username
    let discordUser = "Not provided";
    if (data.customer_information?.discord_data?.username) {
      discordUser = data.customer_information.discord_data.username;
    }

    // Get coupon code if used
    const coupon = data.coupon_id ? 
      variant.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon")?.attributes?.code || "Used" 
      : "None";

    // 🔧 PRICE CALCULATION FIX
    // Priority order for getting the price:
    // 1. unit_price (the actual product price)
    // 2. total (what was paid)
    // 3. full_price from top level
    
    const paymentDetails = variant.invoice_payment?.payment_details || {};
    const currency = paymentDetails.currency || data.payment?.full_price?.currency || "GBP";
    
    // Get price in cents/pence
    let priceCents = paymentDetails.unit_price || 
                     paymentDetails.total || 
                     paymentDetails.gross_sale ||
                     data.payment?.full_price?.base || 
                     "0";
    
    // Convert to decimal
    const price = normalizeMoney(priceCents);
    
    // Format for GBP and USD
    let totalGBP = "0.00";
    let totalUSD = "0.00";
    
    if (currency === "GBP") {
      totalGBP = price;
      // Convert to USD using exchange rate
      const exchangeRate = parseFloat(variant.invoice_payment?.exchange_rate || data.payment?.total?.exchange_rate || 1.35);
      totalUSD = (parseFloat(price) * exchangeRate).toFixed(2);
    } else if (currency === "USD") {
      totalUSD = price;
      // Convert to GBP using exchange rate
      const exchangeRate = parseFloat(variant.invoice_payment?.exchange_rate || data.payment?.total?.exchange_rate || 1.35);
      totalGBP = (parseFloat(price) / exchangeRate).toFixed(2);
    } else {
      // For other currencies, just use the price
      totalGBP = price;
      totalUSD = price;
    }

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
      currency,
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
      totalGBP,
      currency
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
}
.card {
  background: white;
  padding: 40px;
  max-width: 500px;
  width: 100%;
  border-radius: 20px;
  box-shadow: 0 20px 60px rgba(0,0,0,.3);
}
h1 {
  color: #2d3748;
  margin-bottom: 10px;
  font-size: 28px;
}
.subtitle {
  color: #718096;
  margin-bottom: 30px;
  font-size: 14px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  padding: 15px 0;
  border-bottom: 1px solid #e2e8f0;
}
.info-label {
  font-weight: 600;
  color: #4a5568;
}
.info-value {
  color: #2d3748;
  text-align: right;
  font-weight: 500;
}
.price-row {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 20px;
  border-radius: 12px;
  margin: 20px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.price-label {
  font-size: 16px;
  font-weight: 600;
}
.price-value {
  font-size: 24px;
  font-weight: 700;
}
.delivery {
  background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%);
  padding: 20px;
  border-radius: 12px;
  margin-top: 20px;
}
.delivery h3 {
  color: #2d3748;
  margin-bottom: 10px;
  font-size: 18px;
}
.delivery p {
  color: #4a5568;
  line-height: 1.6;
  font-size: 14px;
}
</style>
</head>
<body>
<div class="card">
  <h1>✅ Purchase Confirmed</h1>
  <p class="subtitle">Thank you for your order!</p>

  <div class="info-row">
    <span class="info-label">Order ID</span>
    <span class="info-value">${r.orderId}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Product</span>
    <span class="info-value">${r.product}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Quantity</span>
    <span class="info-value">${r.quantity}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Roblox Username</span>
    <span class="info-value">${r.roblox}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Discord</span>
    <span class="info-value">${r.discordUser}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Email</span>
    <span class="info-value">${maskEmail(r.email)}</span>
  </div>
  <div class="info-row" style="border-bottom: none;">
    <span class="info-label">Country</span>
    <span class="info-value">${r.country}</span>
  </div>

  <div class="price-row">
    <span class="price-label">Total Paid</span>
    <span class="price-value">£${r.totalGBP} / $${r.totalUSD}</span>
  </div>

  <div class="delivery">
    <h3>🚚 Delivery Information</h3>
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