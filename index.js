require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

// Store orders in memory (can be replaced with DB later)
const orders = new Map();

/* =======================
   DISCORD CLIENT
======================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

/* =======================
   SELLAPP WEBHOOK
======================= */
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log("📦 Webhook received:", event);

    // Only process paid / completed orders
    if (event !== "order.paid" && event !== "order.completed") {
      return res.json({ message: "Ignored (not paid)" });
    }

    const orderId = String(data.id);
    const variant = data.product_variants?.[0];

    /* -------- Extract Data -------- */
    const product = variant?.product_title || "Unknown";
    const quantity = variant?.quantity || 1;

    const roblox =
      variant?.additional_information?.find(i =>
        i.label?.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "Unknown";
    const country = data.customer_information?.country || "Unknown";

    const discordUser =
      data.customer_information?.discord_data?.username
        ? `${data.customer_information.discord_data.username}`
        : "Not linked";

    const paidStatus =
      data.status?.status?.status === "COMPLETED" ? "✅ Paid" : "⚠️ Not Paid";

    const createdAt = new Date(data.created_at).toUTCString();

    const grossGBP =
      variant?.invoice_payment?.payment_details?.gross_sale || "0";

    const grossUSD =
      variant?.invoice_payment?.gross_sale_usd || "0";

    const coupon =
      variant?.invoice_payment?.payment_details?.modifications?.find(
        m => m.type === "coupon"
      );

    const couponText = coupon
      ? `${coupon.attributes?.code} (${coupon.amount})`
      : "None";

    /* -------- Save for receipt page -------- */
    orders.set(orderId, {
      product,
      quantity,
      roblox,
      email,
      country,
      discordUser,
      grossGBP,
      grossUSD,
      coupon: couponText,
      createdAt,
      paidStatus
    });

    /* -------- Discord Embed -------- */
    const embed = new EmbedBuilder()
      .setTitle("🛒 New Order Received")
      .setColor(0x5865F2)
      .addFields(
        { name: "📦 Product", value: product, inline: true },
        { name: "🔢 Quantity", value: String(quantity), inline: true },
        { name: "💷 Total (GBP)", value: `£${grossGBP}`, inline: true },
        { name: "💵 Total (USD)", value: `$${grossUSD}`, inline: true },
        { name: "🏷 Coupon", value: couponText, inline: true },
        { name: "🎮 Roblox Username", value: roblox, inline: true },
        { name: "📧 Email", value: email, inline: false },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        { name: "💳 Payment Status", value: paidStatus, inline: true },
        { name: "🆔 Order ID", value: orderId, inline: false },
        { name: "⏰ Order Time (UTC)", value: createdAt, inline: false }
      )
      .setFooter({ text: "RiveMart • Automated Order System" })
      .setTimestamp();

    const channel = await client.channels.fetch(
      process.env.ORDER_CHANNEL_ID
    );

    if (channel) {
      await channel.send({ embeds: [embed] });
    }

    return res.json({ message: "OK" });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.json({ message: "Handled with error" });
  }
});

/* =======================
   SUCCESS / RECEIPT PAGE
======================= */
app.get("/success", (req, res) => {
  const orderId = req.query.order;
  const order = orders.get(orderId);

  if (!order) {
    return res.send("Order not found or still processing.");
  }

  res.send(`
<html>
<head>
  <title>Order Receipt</title>
</head>
<body style="font-family:Arial;background:#0f172a;color:white;padding:40px;text-align:center;">
  <h1>✅ Purchase Successful</h1>

  <p><strong>Order ID:</strong> ${orderId}</p>
  <p><strong>Product:</strong> ${order.product}</p>
  <p><strong>Quantity:</strong> ${order.quantity}</p>
  <p><strong>Total:</strong> £${order.grossGBP} / $${order.grossUSD}</p>
  <p><strong>Coupon:</strong> ${order.coupon}</p>
  <p><strong>Roblox Username:</strong> ${order.roblox}</p>
  <p><strong>Payment Status:</strong> ${order.paidStatus}</p>
  <p><strong>Order Time:</strong> ${order.createdAt}</p>

  <hr style="margin:30px 0;opacity:0.3;">

  <a href="https://discord.com/invite/PRmy2F3gAp"
     style="padding:14px 28px;background:#5865F2;color:white;border-radius:8px;text-decoration:none;font-weight:bold;">
     Join Discord
  </a>

  <p style="margin-top:30px;color:#94a3b8;">
    Keep this page as your receipt.
  </p>
</body>
</html>
`);
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
