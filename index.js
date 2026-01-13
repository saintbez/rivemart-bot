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

    const email = data.customer_information?.email || "Hidden";
    const country = data.customer_information?.country || "Unknown";

    // Extract Discord username from discord_data.username
    let discordUser = "Not provided";
    if (data.customer_information?.discord_data?.username) {
      discordUser = data.customer_information.discord_data.username;
    }

    // Get coupon code if used
    const coupon = data.coupon_id ? 
      data.product_variants?.[0]?.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon")?.attributes?.code || "Used" 
      : "None";

    // 🔧 CALCULATE TOTAL PRICE FROM ALL PRODUCTS
    let totalCents = 0;
    let currency = "GBP";
    const products = [];

    for (const variant of data.product_variants || []) {
      const paymentDetails = variant.invoice_payment?.payment_details || {};
      currency = paymentDetails.currency || currency;
      
      // Get price per unit (always use unit_price as it's most reliable)
      let unitPrice = Number(paymentDetails.unit_price || 0);
      const quantity = variant.quantity || 1;
      const productTotal = unitPrice * quantity;
      totalCents += productTotal;

      // Extract Roblox username for THIS specific product
      let robloxUsername = "Not provided";
      if (variant.additional_information && Array.isArray(variant.additional_information)) {
        const robloxField = variant.additional_information.find(f =>
          f.label && f.label.toLowerCase().includes("roblox")
        );
        if (robloxField && robloxField.value) {
          robloxUsername = robloxField.value;
        }
      }

      products.push({
        name: variant.product_title || "Unknown Product",
        quantity: quantity,
        unitPrice: normalizeMoney(unitPrice),
        total: normalizeMoney(productTotal),
        robloxUsername: robloxUsername
      });

      console.log(`Product: ${variant.product_title}, Qty: ${quantity}, Unit: ${unitPrice}, Total: ${productTotal}, Roblox: ${robloxUsername}`);
    }

    // Convert total to decimal
    const totalPrice = normalizeMoney(totalCents);
    
    // Format for GBP and USD
    let totalGBP = "0.00";
    let totalUSD = "0.00";
    
    if (currency === "GBP") {
      totalGBP = totalPrice;
      const exchangeRate = parseFloat(data.payment?.total?.exchange_rate || 1.35);
      totalUSD = (parseFloat(totalPrice) * exchangeRate).toFixed(2);
    } else if (currency === "USD") {
      totalUSD = totalPrice;
      const exchangeRate = parseFloat(data.payment?.total?.exchange_rate || 1.35);
      totalGBP = (parseFloat(totalPrice) / exchangeRate).toFixed(2);
    } else {
      totalGBP = totalPrice;
      totalUSD = totalPrice;
    }

    const status = "✅ Paid";
    const createdAt = new Date(data.created_at).toUTCString();
    const token = generateToken(orderId);

    orders.set(orderId, {
      orderId,
      products,
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
      products,
      discordUser,
      totalUSD,
      totalGBP,
      currency
    });

    // Build product list for Discord embed
    const productList = products.map(p => 
      `${p.name} x${p.quantity} - ${p.robloxUsername} (£${p.unitPrice} each = £${p.total})`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setTitle("🛒 New Order Received")
      .addFields(
        { name: "📦 Products", value: productList || "No products" },
        { name: "💷 Total (GBP)", value: `£${totalGBP}`, inline: true },
        { name: "💵 Total (USD)", value: `$${totalUSD}`, inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
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

  // Build product rows HTML - SAFE handling for all cases
  let productRows = '';
  try {
    if (r.products && Array.isArray(r.products) && r.products.length > 0) {
      productRows = r.products.map(p => {
        const productName = String(p.name || "Unknown Product");
        const quantity = String(p.quantity || 1);
        const total = String(p.total || "0.00");
        const roblox = String(p.robloxUsername || "Not provided");
        
        return `
        <div class="product-item">
          <div class="product-info">
            <div class="product-name">${productName}</div>
            <div class="product-detail">Quantity: ${quantity}</div>
            <div class="product-detail">Roblox: ${roblox}</div>
          </div>
          <div class="product-price">£${total}</div>
        </div>
        `;
      }).join('');
    } else {
      productRows = '<div class="product-item"><div class="product-info"><div class="product-name">No products found</div></div></div>';
    }
  } catch (err) {
    console.error("Error building product rows:", err);
    productRows = '<div class="product-item"><div class="product-info"><div class="product-name">Error loading products</div></div></div>';
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
  background: white;
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
  max-width: 600px;
  width: 100%;
  border-radius: 12px;
  box-shadow: 0 2px 20px rgba(0,0,0,.1);
  border: 1px solid #e2e8f0;
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
.section-title {
  font-size: 18px;
  font-weight: 600;
  color: #2d3748;
  margin: 25px 0 15px 0;
  padding-bottom: 10px;
  border-bottom: 2px solid #e2e8f0;
}
.product-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  background: #f7fafc;
  border-radius: 8px;
  margin-bottom: 10px;
}
.product-info {
  flex: 1;
}
.product-name {
  font-weight: 600;
  color: #2d3748;
  font-size: 16px;
  margin-bottom: 6px;
}
.product-detail {
  color: #718096;
  font-size: 14px;
  margin-top: 4px;
}
.product-price {
  font-weight: 700;
  color: #2d3748;
  font-size: 18px;
  margin-left: 20px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
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
.total-row {
  background: #2d3748;
  color: white;
  padding: 20px;
  border-radius: 8px;
  margin: 20px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.total-label {
  font-size: 18px;
  font-weight: 600;
}
.total-value {
  font-size: 24px;
  font-weight: 700;
}
.delivery {
  background: #f0fff4;
  border-left: 4px solid #48bb78;
  padding: 20px;
  border-radius: 8px;
  margin-top: 20px;
}
.delivery h3 {
  color: #2d3748;
  margin-bottom: 10px;
  font-size: 16px;
  font-weight: 600;
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

  <div class="section-title">📦 Products</div>
  ${productRows}

  <div class="total-row">
    <span class="total-label">Total Paid</span>
    <span class="total-value">£${r.totalGBP || '0.00'} / $${r.totalUSD || '0.00'}</span>
  </div>

  <div class="section-title">📋 Order Details</div>
  <div class="info-row">
    <span class="info-label">Order ID</span>
    <span class="info-value">${r.orderId || 'Unknown'}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Discord</span>
    <span class="info-value">${r.discordUser || 'Not provided'}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Email</span>
    <span class="info-value">${maskEmail(r.email)}</span>
  </div>
  <div class="info-row" style="border-bottom: none;">
    <span class="info-label">Country</span>
    <span class="info-value">${r.country || 'Unknown'}</span>
  </div>

  <div class="delivery">
    <h3>🚚 Delivery Information</h3>
    <p>
      Our staff will message you via Discord to deliver your products.
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