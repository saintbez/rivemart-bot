require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(express.json());

const orders = new Map();

// Helpers
const normalizeMoney = (cents) => (Number(cents || 0) / 100).toFixed(2);
const maskEmail = (email) => email?.includes("@") ? `${email.slice(0, 3)}***@${email.split("@")[1]}` : "Hidden";
const generateToken = (id) => crypto.createHmac("sha256", process.env.RECEIPT_SECRET).update(id).digest("hex");
const verifyToken = (id, token) => generateToken(id) === token;

// Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`✅ ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// Webhook
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    if (!["order.completed", "order.paid"].includes(event)) return res.json({ ignored: true });

    const orderId = String(data.id);
    const email = data.customer_information?.email || "Hidden";
    const country = data.customer_information?.country || "Unknown";
    const discordUser = data.customer_information?.discord_data?.username || "Not provided";
    
    const couponMod = data.product_variants?.[0]?.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon");
    const coupon = data.coupon_id ? (couponMod?.attributes?.code || "Used") : "None";

    let totalCents = 0;
    let currency = "GBP";
    const products = [];

    for (const variant of data.product_variants || []) {
      const paymentDetails = variant.invoice_payment?.payment_details || {};
      currency = paymentDetails.currency || currency;
      
      const unitPrice = Number(paymentDetails.unit_price || 0);
      const quantity = variant.quantity || 1;
      const productTotal = unitPrice * quantity;
      totalCents += productTotal;

      const robloxField = variant.additional_information?.find(f => f.label?.toLowerCase().includes("roblox"));
      
      products.push({
        name: variant.product_title || "Unknown Product",
        quantity,
        unitPrice: normalizeMoney(unitPrice),
        total: normalizeMoney(productTotal),
        robloxUsername: robloxField?.value || "Not provided"
      });
    }

    const totalPrice = normalizeMoney(totalCents);
    const exchangeRate = parseFloat(data.payment?.total?.exchange_rate || 1.35);
    
    let totalGBP = totalPrice;
    let totalUSD = totalPrice;
    
    if (currency === "GBP") {
      totalUSD = (parseFloat(totalPrice) * exchangeRate).toFixed(2);
    } else if (currency === "USD") {
      totalGBP = (parseFloat(totalPrice) / exchangeRate).toFixed(2);
    }

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
      createdAt: new Date(data.created_at).toUTCString(),
      token
    });

    const productList = products.map(p => 
      `${p.name} x${p.quantity} - ${p.robloxUsername} (£${p.unitPrice} ea = £${p.total})`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setTitle("🛒 New Order")
      .addFields(
        { name: "📦 Products", value: productList || "No products" },
        { name: "💷 Total (GBP)", value: `£${totalGBP}`, inline: true },
        { name: "💵 Total (USD)", value: `$${totalUSD}`, inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "🆔 Order ID", value: orderId },
        { name: "⏰ Time (UTC)", value: new Date(data.created_at).toUTCString() }
      )
      .setFooter({ text: "RiveMart" })
      .setTimestamp();

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) await channel.send({ embeds: [embed] });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// Success redirect
app.get("/success", (req, res) => {
  const order = req.query.order;
  if (!order) return res.status(400).send("Missing order ID");
  res.redirect(`/receipt?order=${order}&token=${generateToken(order)}`);
});

// Receipt page
app.get("/receipt", (req, res) => {
  const { order, token } = req.query;
  
  if (!order || !token || !verifyToken(order, token)) {
    return res.status(403).send("Invalid request");
  }

  const r = orders.get(order);
  
  const productRows = r?.products?.length > 0 
    ? r.products.map(p => `
    <div class="item">
      <div class="item-info">
        <div class="name">${p.name}</div>
        <div class="detail">Qty: ${p.quantity} • Roblox: ${p.robloxUsername}</div>
      </div>
      <div class="price">£${p.total}</div>
    </div>`).join('')
    : '<div class="item"><div class="item-info"><div class="name">Order Confirmed</div></div></div>';

  res.send(`<!DOCTYPE html>
<html>
<head>
<title>RiveMart Receipt${r ? ` - #${r.orderId}` : ''}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f8f9fa;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.card{background:#fff;padding:32px;max-width:600px;width:100%;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
h1{color:#1a1a1a;margin-bottom:8px;font-size:26px}
.sub{color:#666;margin-bottom:24px;font-size:14px}
.section{margin:20px 0}
.title{font-size:16px;font-weight:600;color:#1a1a1a;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e5e7eb}
.item{display:flex;justify-content:space-between;align-items:center;padding:12px;background:#f8f9fa;border-radius:8px;margin-bottom:8px}
.item-info{flex:1}
.name{font-weight:600;color:#1a1a1a;font-size:15px;margin-bottom:4px}
.detail{color:#666;font-size:13px}
.price{font-weight:700;color:#1a1a1a;font-size:17px;margin-left:16px}
.total{background:#1a1a1a;color:#fff;padding:16px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin:20px 0}
.total-label{font-size:16px;font-weight:600}
.total-value{font-size:22px;font-weight:700}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #e5e7eb}
.info-row:last-child{border:none}
.info-label{font-weight:600;color:#4b5563}
.info-value{color:#1a1a1a;text-align:right;font-weight:500}
.delivery{background:#f0fdf4;border-left:4px solid #10b981;padding:16px;border-radius:8px;margin-top:20px}
.delivery h3{color:#1a1a1a;margin-bottom:8px;font-size:15px;font-weight:600}
.delivery p{color:#4b5563;line-height:1.5;font-size:13px;margin-top:8px}
.warning{background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:8px;margin:16px 0;font-size:13px;color:#92400e}
.buttons{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;transition:all .2s}
.btn-primary{background:#1a1a1a;color:#fff}
.btn-primary:hover{background:#333}
.btn-secondary{background:#f8f9fa;color:#1a1a1a;border:2px solid #e5e7eb}
.btn-secondary:hover{background:#e5e7eb}
@media(max-width:640px){.card{padding:24px}}
</style>
</head>
<body>
<div class="card">
<h1>✅ Purchase Confirmed</h1>
<p class="sub">Thank you for your order!</p>

<div class="warning">
📸 <strong>Screenshot this page!</strong> This receipt is hard to access again later.
</div>

${r && r.products?.length > 0 ? `
<div class="section">
<div class="title">📦 Products</div>
${productRows}
</div>

<div class="total">
<span class="total-label">Total Paid</span>
<span class="total-value">£${r.totalGBP} / $${r.totalUSD}</span>
</div>

<div class="section">
<div class="title">📋 Order Details</div>
<div class="info-row">
<span class="info-label">Order ID</span>
<span class="info-value">${r.orderId}</span>
</div>
<div class="info-row">
<span class="info-label">Discord</span>
<span class="info-value">${r.discordUser}</span>
</div>
<div class="info-row">
<span class="info-label">Email</span>
<span class="info-value">${maskEmail(r.email)}</span>
</div>
<div class="info-row">
<span class="info-label">Country</span>
<span class="info-value">${r.country}</span>
</div>
</div>` : `
<div class="section">
<div class="info-row">
<span class="info-label">Order ID</span>
<span class="info-value">${order}</span>
</div>
</div>`}

<div class="delivery">
<h3>🚚 Delivery Information</h3>
<p>Our staff will message you via Discord to deliver your products. Please ensure your DMs are open and you've joined the RiveMart server.</p>
<p style="margin-top:10px;font-size:12px;color:#6b7280">Questions? Contact support with Order ID: <strong>${r?.orderId || order}</strong></p>
</div>

<div class="buttons">
<a href="https://discord.gg/rivemart" class="btn btn-primary">💬 Contact Support</a>
<a href="https://discord.gg/rivemart" class="btn btn-secondary">🔒 Join Private Server</a>
<a href="https://rivemart.shop" class="btn btn-secondary">← Back to RiveMart.shop</a>
</div>

</div>
</body>
</html>`);
});

// Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));