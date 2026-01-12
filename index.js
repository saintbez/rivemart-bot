require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits } = require("discord.js");

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

    // Treat order.paid as completed (SellApp change)
    if (event !== "order.paid" && event !== "order.completed") {
      return res.json({ message: "Ignored (not paid)" });
    }

    const orderId = data.id.toString();
    const variant = data.product_variants?.[0] || {};
    const paymentDetails = variant.invoice_payment?.payment_details || {};

    const product = variant.product_title || "Unknown";
    const quantity = paymentDetails.quantity || 1;

    const totalGBP = formatMoney(paymentDetails.gross_sale, "£");
    const totalUSD = formatMoney(data.payment?.total?.gross_sale_usd, "$");

    const coupon =
      paymentDetails.modifications?.find(m => m.type === "coupon")
        ? paymentDetails.modifications[0].attributes?.code || "Applied"
        : "None";

    const roblox =
      variant.additional_information?.find(f =>
        f.label?.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "Unknown";
    const country = data.customer_information?.country || "Unknown";

    const discordUser =
      data.customer_information?.discord_data?.username
        ? `${data.customer_information.discord_data.username}`
        : "Not linked";

    const paid =
      data.status?.status?.status === "COMPLETED" ||
      data.payment?.total?.total_usd === "0";

    const orderTime = new Date(data.created_at).toUTCString();

    // ==================
    // Store order securely (receipt use)
    // ==================
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
    // Discord Message
    // ==================
    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);

    if (channel) {
      await channel.send(
`🛒 **New Order Received**

📦 **Product**
${product}

🔢 **Quantity**
${quantity}

💷 **Total (GBP)**
${totalGBP}

💵 **Total (USD)**
${totalUSD}

🏷 **Coupon**
${coupon}

🎮 **Roblox Username**
${roblox}

📧 **Email**
${email}

🌍 **Country**
${country}

💬 **Discord**
${discordUser}

💳 **Payment Status**
${paid ? "✅ Paid" : "⏳ Pending"}

🆔 **Order ID**
${orderId}

⏰ **Order Time (UTC)**
${orderTime}`
      );
    }

    return res.json({ message: "OK" });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ message: "Webhook error" });
  }
});

// ==================
// Receipt / Success Page
// ==================
app.get("/success", (req, res) => {
  const orderId = req.query.order;

  if (!orderId || !orders.has(orderId)) {
    return res.send("❌ Order not found or not processed yet.");
  }

  const o = orders.get(orderId);

  res.send(`
  <html>
    <head>
      <title>Order Receipt</title>
    </head>
    <body style="font-family:Arial;text-align:center;padding:40px;">
      <h1>✅ Purchase Successful</h1>

      <p><strong>Order ID:</strong> ${orderId}</p>
      <p><strong>Product:</strong> ${o.product}</p>
      <p><strong>Quantity:</strong> ${o.quantity}</p>
      <p><strong>Total:</strong> ${o.totalGBP} (${o.totalUSD})</p>
      <p><strong>Roblox Username:</strong> ${o.roblox}</p>
      <p><strong>Email:</strong> ${o.email}</p>
      <p><strong>Payment Status:</strong> ${o.paid ? "Paid" : "Pending"}</p>
      <p><strong>Order Time:</strong> ${o.orderTime}</p>

      <hr style="margin:30px 0;">

      <a href="https://discord.com/invite/PRmy2F3gAp"
        style="display:inline-block;padding:12px 24px;margin:8px;background:#5865F2;color:white;border-radius:6px;text-decoration:none;font-weight:bold;">
        Join Discord
      </a>

      <a href="https://discord.com/channels/1457151716238561321"
        style="display:inline-block;padding:12px 24px;margin:8px;background:#2F3136;color:white;border-radius:6px;text-decoration:none;font-weight:bold;">
        Open Support Ticket
      </a>

      <p style="margin-top:30px;color:#777;">
        Keep this page as your receipt.
      </p>
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
