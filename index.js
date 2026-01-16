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

// Sell.app API helper
async function createSupportTicket(orderId, email, products, discordUser) {
  try {
    const productList = products.map(p => 
      `${p.name} x${p.quantity} - Roblox: ${p.robloxUsername}`
    ).join('\n');

    console.log(`🎫 Attempting to create ticket for order ${orderId}...`);
    console.log(`   Email: ${email}`);
    console.log(`   API Key: ${process.env.SELLAPP_API_KEY ? 'SET' : 'MISSING'}`);

    const response = await fetch("https://sell.app/api/v1/tickets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SELLAPP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: email,
        subject: `Order Support - #${orderId}`,
        message: `Hello! I just completed order #${orderId}.\n\nProducts:\n${productList}\n\nDiscord: ${discordUser}\n\nI have a question about my order.`,
        priority: "medium"
      })
    });

    console.log(`   Response status: ${response.status} ${response.statusText}`);
    
    const responseText = await response.text();
    console.log(`   Response body: ${responseText}`);
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.error(`   Failed to parse response as JSON:`, parseErr);
      return { success: false, error: `Invalid JSON response: ${responseText}` };
    }
    
    if (response.ok) {
      console.log(`✅ Ticket created for order ${orderId}:`, data);
      return { success: true, ticketId: data.data?.id };
    } else {
      console.error(`❌ Failed to create ticket:`, data);
      return { success: false, error: data.message || JSON.stringify(data) };
    }
  } catch (err) {
    console.error("❌ Ticket creation error:", err);
    console.error("   Error stack:", err.stack);
    return { success: false, error: err.message };
  }
}

// Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`✅ ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// Webhook
app.post("/sellapp-webhook", async (req, res) => {
  try {
    console.log("📦 Webhook received:", JSON.stringify(req.body, null, 2));
    
    const { event, data } = req.body;
    if (!["order.completed", "order.paid"].includes(event)) return res.json({ ignored: true });

    const orderId = String(data.id);
    const custInfo = data.customer_information || {};
    const email = custInfo.email || "Hidden";
    const country = custInfo.country || "Unknown";
    const discordUser = custInfo.discord_data?.username || "Not provided";
    
    // Get coupon info
    const couponMod = data.product_variants?.[0]?.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon");
    const coupon = data.coupon_id ? (couponMod?.attributes?.code || "Used") : "None";

    // Get currency from payment data
    const currency = data.payment?.full_price?.currency || data.payment?.total?.payment_details?.currency || "GBP";
    const exchangeRate = parseFloat(data.payment?.total?.exchange_rate || 1.35);

    const products = [];
    let totalCents = 0;

    // Process each product variant
    for (const variant of data.product_variants || []) {
      const paymentDetails = variant.invoice_payment?.payment_details || {};
      
      // Get the actual unit price (before discounts)
      const unitPrice = Number(paymentDetails.unit_price || 0);
      const quantity = variant.quantity || 1;
      
      // Calculate product total from unit price
      const productTotal = unitPrice * quantity;
      totalCents += productTotal;

      // Extract Roblox username from additional info
      const robloxField = variant.additional_information?.find(f => 
        f.label?.toLowerCase().includes("roblox")
      );
      
      products.push({
        name: variant.product_title || "Unknown Product",
        quantity,
        unitPrice: normalizeMoney(unitPrice),
        total: normalizeMoney(productTotal),
        robloxUsername: robloxField?.value || "Not provided"
      });

      console.log(`✅ Product: ${variant.product_title}, Unit: ${unitPrice}, Qty: ${quantity}, Total: ${productTotal}`);
    }

    // Calculate totals - use full_price as the actual price before any modifications
    const fullPriceCents = Number(data.payment?.full_price?.base || totalCents);
    const actualPaidCents = Number(data.payment?.total?.payment_details?.total || 0);
    
    // Use full price for display (what they would have paid without coupon)
    const displayPrice = normalizeMoney(fullPriceCents);
    
    let totalGBP = displayPrice;
    let totalUSD = displayPrice;
    
    if (currency === "GBP") {
      totalUSD = (parseFloat(displayPrice) * exchangeRate).toFixed(2);
    } else if (currency === "USD") {
      totalGBP = (parseFloat(displayPrice) / exchangeRate).toFixed(2);
    }

    console.log(`💰 Currency: ${currency}, Full Price: ${fullPriceCents}, Paid: ${actualPaidCents}, GBP: ${totalGBP}, USD: ${totalUSD}`);

    const token = generateToken(orderId);
    const orderData = {
      orderId,
      products,
      email,
      country,
      discordUser,
      coupon,
      totalUSD,
      totalGBP,
      currency,
      actualPaid: normalizeMoney(actualPaidCents),
      createdAt: new Date(data.created_at).toUTCString(),
      token
    };

    orders.set(orderId, orderData);
    console.log(`✅ Order ${orderId} stored:`, JSON.stringify(orderData, null, 2));

    // Discord embed
    const productList = products.map(p => 
      `${p.name} x${p.quantity} - ${p.robloxUsername} (£${p.unitPrice} ea = £${p.total})`
    ).join('\n');

    const priceDisplay = actualPaidCents === 0 
      ? `£${totalGBP} / $${totalUSD} (FREE with coupon)`
      : `£${totalGBP} / $${totalUSD}`;

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setTitle("🛒 New Order")
      .addFields(
        { name: "📦 Products", value: productList || "No products" },
        { name: "💷 Total", value: priceDisplay, inline: true },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "📧 Email", value: maskEmail(email), inline: true },
        { name: "🆔 Order ID", value: orderId }
      )
      .setFooter({ text: "RiveMart" })
      .setTimestamp();

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) {
      await channel.send({ embeds: [embed] });
      console.log("✅ Discord notification sent");
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// NEW: Endpoint to create ticket
app.post("/create-ticket", async (req, res) => {
  const { order, token } = req.body;
  
  if (!order || !token || !verifyToken(order, token)) {
    return res.status(403).json({ error: "Invalid request" });
  }

  const orderData = orders.get(order);
  if (!orderData) {
    return res.status(404).json({ error: "Order not found" });
  }

  const result = await createSupportTicket(
    orderData.orderId,
    orderData.email,
    orderData.products,
    orderData.discordUser
  );

  res.json(result);
});

// Success redirect
app.get("/success", (req, res) => {
  const order = req.query.order;
  console.log(`📄 Success redirect for order: ${order}`);
  if (!order) return res.status(400).send("Missing order ID");
  res.redirect(`/receipt?order=${order}&token=${generateToken(order)}`);
});

// Receipt page
app.get("/receipt", (req, res) => {
  const { order, token } = req.query;
  
  console.log(`📄 Receipt requested - Order: ${order}, Token: ${token?.substring(0, 10)}...`);
  
  if (!order || !token || !verifyToken(order, token)) {
    console.error("❌ Invalid receipt request");
    return res.status(403).send("Invalid request");
  }

  const r = orders.get(order);
  console.log(`📦 Order data retrieved:`, r ? "FOUND" : "NOT FOUND");
  
  if (r) {
    console.log(`   Products count: ${r.products?.length || 0}`);
    console.log(`   Products:`, JSON.stringify(r.products, null, 2));
  }

  // Build product rows - ALWAYS show products if they exist
  let productRows = '';
  
  if (r?.products && Array.isArray(r.products) && r.products.length > 0) {
    productRows = r.products.map(p => `
    <div class="item">
      <div class="item-info">
        <div class="name">${p.name || 'Product'}</div>
        <div class="detail">Qty: ${p.quantity || 1} • Roblox: ${p.robloxUsername || 'Not provided'}</div>
      </div>
      <div class="price">£${p.total || '0.00'}</div>
    </div>`).join('');
    console.log(`✅ Generated ${r.products.length} product rows`);
  } else {
    productRows = '<div class="item"><div class="item-info"><div class="name">Order Confirmed</div><div class="detail">Order processing...</div></div></div>';
    console.log(`⚠️ No products found, showing fallback`);
  }

  // Show actual paid amount if different from total
  const totalDisplay = r && r.actualPaid !== r.totalGBP 
    ? `<div class="total">
       <div>
         <div class="total-label">Original Price</div>
         <div style="font-size:14px;opacity:0.8;margin-top:4px">Paid: £${r.actualPaid} / $${(parseFloat(r.actualPaid) * 1.35).toFixed(2)}</div>
       </div>
       <span class="total-value">£${r.totalGBP} / $${r.totalUSD}</span>
       </div>`
    : r ? `<div class="total">
       <span class="total-label">Total Paid</span>
       <span class="total-value">£${r.totalGBP} / $${r.totalUSD}</span>
       </div>` : '';

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
.price{font-weight:700;color:#1a1a1a;font-size:17px;margin-left:16px;white-space:nowrap}
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
.warning{background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;border-radius:8px;margin:16px 0;font-size:13px;color:#92400e;font-weight:500}
.buttons{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;transition:all .2s;border:none;cursor:pointer;width:100%}
.btn-primary{background:#1a1a1a;color:#fff}
.btn-primary:hover{background:#333}
.btn-secondary{background:#f8f9fa;color:#1a1a1a;border:2px solid #e5e7eb}
.btn-secondary:hover{background:#e5e7eb}
.btn-success{background:#10b981;color:#fff}
.btn-success:hover{background:#059669}
.btn:disabled{opacity:0.5;cursor:not-allowed}
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

<div class="section">
<div class="title">📦 Products</div>
${productRows}
</div>

${totalDisplay}

${r ? `<div class="section">
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
${r.coupon !== "None" ? `<div class="info-row">
<span class="info-label">Coupon</span>
<span class="info-value">${r.coupon}</span>
</div>` : ''}
</div>` : `<div class="section">
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
<button id="ticketBtn" class="btn btn-success">🎫 Open Support Ticket</button>
<a href="https://discord.com/channels/1457151716238561321/1457151718528778423/1460352217717674105" class="btn btn-primary">💬 Contact Support</a>
<a href="https://www.roblox.com/share?code=eee03c29a2e4ec4b9f124a4c17af35be&type=Server" class="btn btn-secondary">🔒 Join Private Server</a>
<a href="https://rivemart.shop" class="btn btn-secondary">← Back to RiveMart.shop</a>
</div>

</div>

<script>
const ticketBtn = document.getElementById('ticketBtn');
ticketBtn.addEventListener('click', async () => {
  ticketBtn.disabled = true;
  ticketBtn.textContent = '⏳ Creating ticket...';
  
  try {
    const response = await fetch('/create-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order: '${order}',
        token: '${token}'
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      ticketBtn.textContent = '✅ Ticket Created!';
      ticketBtn.className = 'btn btn-success';
      alert('Support ticket created! Check your email for updates.');
    } else {
      throw new Error(data.error || 'Failed to create ticket');
    }
  } catch (err) {
    ticketBtn.textContent = '❌ Failed - Try Discord';
    ticketBtn.className = 'btn btn-secondary';
    alert('Could not create ticket. Please use Discord support instead.');
  }
  
  setTimeout(() => {
    ticketBtn.disabled = false;
    if (ticketBtn.textContent === '✅ Ticket Created!') {
      ticketBtn.textContent = '🎫 Open Support Ticket';
      ticketBtn.className = 'btn btn-success';
    }
  }, 3000);
});
</script>
</body>
</html>`);
});

// Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));