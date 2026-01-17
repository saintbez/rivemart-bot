}
</script>
</body>
</html>`);
});

// Server - IMPORTANT: Use httpServer instead of app!
const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`🌐 Port ${PORT}`));require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

const orders = new Map();
const chats = new Map(); // Store chat messages per order

// Helpers
const normalizeMoney = (cents) => (Number(cents || 0) / 100).toFixed(2);
const maskEmail = (email) => email?.includes("@") ? `${email.slice(0, 3)}***@${email.split("@")[1]}` : "Hidden";
const generateToken = (id) => crypto.createHmac("sha256", process.env.RECEIPT_SECRET).update(id).digest("hex");
const verifyToken = (id, token) => generateToken(id) === token;

// Discord
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`✅ ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// Socket.io connection
io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  socket.on("join-order", ({ orderId, token, role }) => {
    if (!verifyToken(orderId, token)) {
      socket.emit("error", "Invalid token");
      return;
    }

    socket.join(`order-${orderId}`);
    socket.orderId = orderId;
    socket.role = role || "customer";

    // Send chat history
    const chatHistory = chats.get(orderId) || [];
    socket.emit("chat-history", chatHistory);

    console.log(`✅ ${role} joined order ${orderId}`);
  });

  socket.on("send-message", async ({ orderId, token, message, sender }) => {
    if (!verifyToken(orderId, token)) {
      socket.emit("error", "Invalid token");
      return;
    }

    const chatMessage = {
      id: Date.now(),
      sender,
      message,
      timestamp: new Date().toISOString()
    };

    // Store message
    if (!chats.has(orderId)) {
      chats.set(orderId, []);
    }
    chats.get(orderId).push(chatMessage);

    // Broadcast to everyone in this order's room
    io.to(`order-${orderId}`).emit("new-message", chatMessage);

    console.log(`💬 [Order ${orderId}] ${sender}: ${message}`);

    // Notify staff in Discord when customer sends message
    if (sender === "customer") {
      try {
        const orderData = orders.get(orderId);
        const baseUrl = process.env.BASE_URL || "http://localhost:8080";
        
        const embed = new EmbedBuilder()
          .setColor(0xff6b35)
          .setTitle("💬 New Customer Message")
          .setDescription(`\`\`\`${message}\`\`\``)
          .addFields(
            { name: "Order", value: `#${orderId}`, inline: true },
            { name: "Customer", value: orderData?.discordUser || "Unknown", inline: true },
            { name: "Reply", value: `[Click here to reply](${baseUrl}/admin?order=${orderId}&token=${token})`, inline: false }
          )
          .setTimestamp();

        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID || process.env.ORDER_CHANNEL_ID);
        if (channel) {
          await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error("Failed to send Discord notification:", err);
      }
    }
  });

  socket.on("mark-complete", ({ orderId, token }) => {
    if (!verifyToken(orderId, token)) {
      socket.emit("error", "Invalid token");
      return;
    }

    const orderData = orders.get(orderId);
    if (orderData) {
      orderData.completed = true;
      orderData.completedAt = new Date().toISOString();
    }

    io.to(`order-${orderId}`).emit("order-completed");
    console.log(`✅ Order ${orderId} marked complete`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 User disconnected: ${socket.id}`);
  });
});

// Submit review
app.post("/submit-review", async (req, res) => {
  const { order, token, rating, review } = req.body;
  
  if (!order || !token || !verifyToken(order, token)) {
    return res.status(403).json({ error: "Invalid request" });
  }

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be 1-5" });
  }

  const orderData = orders.get(order);
  if (orderData) {
    orderData.review = { rating, review, submittedAt: new Date().toISOString() };
  }

  // Send to Discord
  try {
    const stars = '⭐'.repeat(rating);
    const embed = new EmbedBuilder()
      .setColor(rating >= 4 ? 0x10b981 : rating >= 3 ? 0xf59e0b : 0xef4444)
      .setTitle("⭐ New Review")
      .addFields(
        { name: "Rating", value: stars, inline: true },
        { name: "Order", value: `#${order}`, inline: true },
        { name: "Customer", value: orderData?.discordUser || "Unknown", inline: true }
      )
      .setTimestamp();

    if (review) {
      embed.setDescription(review);
    }

    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Failed to send review to Discord:", err);
  }

  res.json({ success: true });
});

// Admin reply page
app.get("/admin", (req, res) => {
  const { order, token } = req.query;
  
  if (!order || !token || !verifyToken(order, token)) {
    return res.status(403).send("Invalid request");
  }

  const orderData = orders.get(order);
  
  res.send(`<!DOCTYPE html>
<html>
<head>
<title>Admin - Order #${order}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a1a;font-family:system-ui,-apple-system,sans-serif;color:#fff;padding:20px}
.container{max-width:800px;margin:0 auto}
.header{background:#2a2a2a;padding:20px;border-radius:12px;margin-bottom:20px}
.header h1{font-size:24px;margin-bottom:8px}
.header p{color:#999;font-size:14px}
.chat-box{background:#2a2a2a;border-radius:12px;padding:20px;height:400px;overflow-y:auto;margin-bottom:20px}
.message{margin-bottom:16px;display:flex;gap:12px}
.message.staff{flex-direction:row-reverse}
.message-content{max-width:70%;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.5}
.message.customer .message-content{background:#3b82f6;color:#fff}
.message.staff .message-content{background:#10b981;color:#fff}
.message-time{font-size:11px;color:#666;margin-top:4px}
.input-box{display:flex;gap:10px}
.input-box input{flex:1;padding:12px 16px;border-radius:8px;border:2px solid #3a3a3a;background:#2a2a2a;color:#fff;font-size:14px}
.input-box input:focus{outline:none;border-color:#3b82f6}
.input-box button{padding:12px 24px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px}
.input-box button:hover{background:#2563eb}
.info{background:#2a2a2a;padding:16px;border-radius:8px;margin-bottom:20px}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #3a3a3a}
.info-row:last-child{border:none}
.info-label{color:#999;font-size:13px}
.info-value{color:#fff;font-weight:500;font-size:13px}
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>💬 Order Support Chat</h1>
<p>Responding to Order #${order}</p>
</div>

${orderData ? `<div class="info">
<div class="info-row">
<span class="info-label">Customer</span>
<span class="info-value">${orderData.discordUser}</span>
</div>
<div class="info-row">
<span class="info-label">Email</span>
<span class="info-value">${orderData.email}</span>
</div>
<div class="info-row">
<span class="info-label">Products</span>
<span class="info-value">${orderData.products?.map(p => p.name).join(', ') || 'Loading...'}</span>
</div>
</div>` : ''}

<div class="chat-box" id="chatBox"></div>

<div class="input-box">
<input type="text" id="messageInput" placeholder="Type your message..." />
<button onclick="sendMessage()">Send</button>
</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const orderId = '${order}';
const token = '${token}';
const chatBox = document.getElementById('chatBox');
const messageInput = document.getElementById('messageInput');

socket.emit('join-order', { orderId, token, role: 'staff' });

socket.on('chat-history', (messages) => {
  messages.forEach(msg => displayMessage(msg));
});

socket.on('new-message', (msg) => {
  displayMessage(msg);
});

function displayMessage(msg) {
  const messageDiv = document.createElement('div');
  messageDiv.className = \`message \${msg.sender}\`;
  
  const time = new Date(msg.timestamp).toLocaleTimeString();
  
  messageDiv.innerHTML = \`
    <div class="message-content">
      \${msg.message}
      <div class="message-time">\${time}</div>
    </div>
  \`;
  
  chatBox.appendChild(messageDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;
  
  socket.emit('send-message', {
    orderId,
    token,
    message,
    sender: 'staff'
  });
  
  messageInput.value = '';
}

messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});
</script>
</body>
</html>`);
});

// Webhook
app.post("/sellapp-webhook", async (req, res) => {
  try {
    console.log("📦 Webhook received");
    
    const { event, data } = req.body;
    if (!["order.completed", "order.paid"].includes(event)) return res.json({ ignored: true });

    const orderId = String(data.id);
    const custInfo = data.customer_information || {};
    const email = custInfo.email || "Hidden";
    const country = custInfo.country || "Unknown";
    const discordUser = custInfo.discord_data?.username || "Not provided";
    
    const couponMod = data.product_variants?.[0]?.invoice_payment?.payment_details?.modifications?.find(m => m.type === "coupon");
    const coupon = data.coupon_id ? (couponMod?.attributes?.code || "Used") : "None";

    const currency = data.payment?.full_price?.currency || data.payment?.total?.payment_details?.currency || "GBP";
    const exchangeRate = parseFloat(data.payment?.total?.exchange_rate || 1.35);

    const products = [];
    let totalCents = 0;

    for (const variant of data.product_variants || []) {
      const paymentDetails = variant.invoice_payment?.payment_details || {};
      const unitPrice = Number(paymentDetails.unit_price || 0);
      const quantity = variant.quantity || 1;
      const productTotal = unitPrice * quantity;
      totalCents += productTotal;

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
    }

    const fullPriceCents = Number(data.payment?.full_price?.base || totalCents);
    const actualPaidCents = Number(data.payment?.total?.payment_details?.total || 0);
    const displayPrice = normalizeMoney(fullPriceCents);
    
    let totalGBP = displayPrice;
    let totalUSD = displayPrice;
    
    if (currency === "GBP") {
      totalUSD = (parseFloat(displayPrice) * exchangeRate).toFixed(2);
    } else if (currency === "USD") {
      totalGBP = (parseFloat(displayPrice) / exchangeRate).toFixed(2);
    }

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
      completed: false,
      token
    };

    orders.set(orderId, orderData);
    console.log(`✅ Order ${orderId} stored`);

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
    res.status(500).json({ error: "Webhook failed" });
  }
});

// Success redirect
app.get("/success", (req, res) => {
  const order = req.query.order;
  if (!order) return res.status(400).send("Missing order ID");
  res.redirect(`/receipt?order=${order}&token=${generateToken(order)}`);
});

// Receipt page with chat
app.get("/receipt", (req, res) => {
  const { order, token } = req.query;
  
  if (!order || !token || !verifyToken(order, token)) {
    return res.status(403).send("Invalid request");
  }

  const r = orders.get(order);
  
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
  } else {
    productRows = '<div class="item"><div class="item-info"><div class="name">Order Confirmed</div><div class="detail">Order processing...</div></div></div>';
  }

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
body{background:#f8f9fa;font-family:system-ui,-apple-system,sans-serif;padding:20px}
.container{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1fr 400px;gap:20px}
@media(max-width:968px){.container{grid-template-columns:1fr}}
.card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
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
.chat-container{background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);display:flex;flex-direction:column;height:600px}
.chat-header{padding:20px;border-bottom:2px solid #e5e7eb}
.chat-header h2{font-size:18px;margin-bottom:4px}
.chat-header p{font-size:13px;color:#666}
.chat-messages{flex:1;padding:20px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
.message{max-width:80%;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.5;word-wrap:break-word}
.message.customer{background:#3b82f6;color:#fff;align-self:flex-end}
.message.staff{background:#e5e7eb;color:#1a1a1a;align-self:flex-start}
.message-time{font-size:11px;opacity:0.7;margin-top:4px}
.chat-input{padding:16px;border-top:2px solid #e5e7eb;display:flex;gap:10px}
.chat-input input{flex:1;padding:10px 14px;border-radius:8px;border:2px solid #e5e7eb;font-size:14px}
.chat-input input:focus{outline:none;border-color:#3b82f6}
.chat-input button{padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer}
.chat-input button:hover{background:#2563eb}
.complete-section{padding:20px;background:#f0fdf4;border-radius:8px;margin-top:20px}
.complete-section h3{color:#1a1a1a;margin-bottom:12px;font-size:16px}
.complete-btn{background:#10b981;color:#fff;padding:12px;border:none;border-radius:8px;font-weight:600;cursor:pointer;width:100%;margin-bottom:10px}
.complete-btn:hover{background:#059669}
.review-section{display:none;margin-top:16px}
.review-section.show{display:block}
.stars{display:flex;gap:8px;margin:12px 0;justify-content:center}
.star{font-size:32px;cursor:pointer;transition:all .2s}
.star:hover,.star.selected{transform:scale(1.2)}
.review-text{width:100%;padding:12px;border-radius:8px;border:2px solid #e5e7eb;font-size:14px;margin-top:12px;font-family:inherit}
.submit-review{background:#1a1a1a;color:#fff;padding:12px;border:none;border-radius:8px;font-weight:600;cursor:pointer;width:100%;margin-top:10px}
.submit-review:hover{background:#333}
</style>
</head>
<body>
<div class="container">
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
</div>` : ''}

<div class="buttons">
<a href="https://www.roblox.com/share?code=eee03c29a2e4ec4b9f124a4c17af35be&type=Server" class="btn btn-primary">🔒 Join Private Server</a>
<a href="https://rivemart.shop" class="btn btn-secondary">← Back to RiveMart.shop</a>
</div>
</div>

<div class="chat-container">
<div class="chat-header">
<h2>💬 Order Support Chat</h2>
<p>Chat with staff to coordinate delivery</p>
</div>
<div class="chat-messages" id="chatMessages"></div>
<div class="chat-input">
<input type="text" id="messageInput" placeholder="Type a message..." />
<button onclick="sendMessage()">Send</button>
</div>

<div class="complete-section">
<h3>✅ Order Delivery</h3>
<button class="complete-btn" onclick="markComplete()">Mark Order Complete</button>
<div class="review-section" id="reviewSection">
<h3 style="text-align:center;margin-bottom:8px">Rate your experience</h3>
<div class="stars" id="stars">
<span class="star" data-rating="1">⭐</span>
<span class="star" data-rating="2">⭐</span>
<span class="star" data-rating="3">⭐</span>
<span class="star" data-rating="4">⭐</span>
<span class="star" data-rating="5">⭐</span>
</div>
<textarea class="review-text" id="reviewText" placeholder="Leave a review (optional)" rows="3"></textarea>
<button class="submit-review" onclick="submitReview()">Submit Review</button>
</div>
</div>
</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const orderId = '${order}';
const token = '${token}';
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
let selectedRating = 0;

socket.emit('join-order', { orderId, token, role: 'customer' });

socket.on('chat-history', (messages) => {
  messages.forEach(msg => displayMessage(msg));
});

socket.on('new-message', (msg) => {
  displayMessage(msg);
});

socket.on('order-completed', () => {
  alert('Order marked as complete!');
});

function displayMessage(msg) {
  const messageDiv = document.createElement('div');
  messageDiv.className = \`message \${msg.sender}\`;
  
  const time = new Date(msg.timestamp).toLocaleTimeString();
  
  messageDiv.innerHTML = \`
    \${msg.message}
    <div class="message-time">\${time}</div>
  \`;
  
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;
  
  socket.emit('send-message', {
    orderId,
    token,
    message,
    sender: 'customer'
  });
  
  messageInput.value = '';
}

messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function markComplete() {
  socket.emit('mark-complete', { orderId, token });
  document.getElementById('reviewSection').classList.add('show');
  alert('✅ Order marked as complete! Please leave a review below.');
}

// Star rating
document.querySelectorAll('.star').forEach(star => {
  star.addEventListener('click', () => {
    selectedRating = parseInt(star.dataset.rating);
    document.querySelectorAll('.star').forEach((s, i) => {
      if (i < selectedRating) {
        s.classList.add('selected');
      } else {
        s.classList.remove('selected');
      }
    });
  });
});

async function submitReview() {
  if (selectedRating === 0) {
    alert('Please select a star rating');
    return;
  }
  
  const review = document.getElementById('reviewText').value.trim();
  
  try {
    const response = await fetch('/submit-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order: orderId,
        token: token,
        rating: selectedRating,
        review: review
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      alert('✅ Thank you for your review!');
      document.getElementById('reviewSection').innerHTML = '<p style="text-align:center;color:#10b981;font-weight:600;">Thank you for your review! ❤️</p>';
    } else {
      alert('Failed to submit review. Please try again.');
    }
  } catch (err) {
    alert('Failed to submit review. Please try again.');
  }
}