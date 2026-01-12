require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/* ============================
   In-memory order store
   ============================ */
const orders = new Map();

/* ============================
   Helpers
   ============================ */
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

function formatMoney(amount, currency) {
  if (!amount) return `0 ${currency}`;
  return `${currency} ${(Number(amount) / 100).toFixed(2)}`;
}

/* ============================
   Discord Bot
   ============================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

/* ============================
   SellApp Webhook
   ============================ */
app.post("/sellapp-webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log("📦 Webhook:", event);

    if (event !== "order.paid" && event !== "order.completed") {
      return res.json({ ignored: true });
    }

    const orderId = String(data.id);
    const variant = data.product_variants?.[0];

    const product = variant?.product_title || "Unknown";
    const quantity = variant?.quantity || 1;

    const roblox =
      variant?.additional_information?.find(i =>
        i.label.toLowerCase().includes("roblox")
      )?.value || "Not provided";

    const email = data.customer_information?.email || "";
    const country = data.customer_information?.country || "Unknown";
    const discordUser =
      data.customer_information?.discord_data?.username || "Not linked";

    const paid = data.status?.status?.status === "COMPLETED";

    const totalGBP =
      data.payment?.full_price?.total?.inclusive || 0;

    const totalUSD =
      data.payment?.total?.gross_sale_usd || 0;

    const coupon =
      variant?.invoice_payment?.payment_details?.modifications?.[0]
        ?.attributes?.code || "None";

    const createdAt = new Date(data.created_at).toUTCString();
    const token = generateToken(orderId);

    /* Store order securely */
    orders.set(orderId, {
      product,
      quantity,
      roblox,
      email,
      country,
      discordUser,
      paid,
      totalGBP,
      totalUSD,
      coupon,
      createdAt,
      token
    });

    /* Discord Embed */
    const embed = new EmbedBuilder()
      .setTitle("🛒 New Order Received")
      .setColor(paid ? 0x57f287 : 0xed4245)
      .addFields(
        { name: "📦 Product", value: product, inline: true },
        { name: "🔢 Quantity", value: String(quantity), inline: true },
        {
          name: "💷 Total (GBP)",
          value: `£${(totalGBP / 100).toFixed(2)}`,
          inline: true
        },
        {
          name: "💵 Total (USD)",
          value: `$${(totalUSD / 100).toFixed(2)}`,
          inline: true
        },
        { name: "🏷 Coupon", value: coupon, inline: true },
        { name: "🎮 Roblox Username", value: roblox, inline: true },
        { name: "🌍 Country", value: country, inline: true },
        { name: "💬 Discord", value: discordUser, inline: true },
        {
          name: "💳 Payment Status",
          value: paid ? "✅ Paid" : "❌ Not Paid",
          inline: true
        },
        { name: "🆔 Order ID", value: orderId, inline: false },
        { name: "⏰ Order Time (UTC)", value: createdAt, inline: false }
      )
      .setFooter({ text: "RiveMart • Automated Order System" })
      .setTimestamp();

    const channel = await client.channels.fetch(
      process.env.ORDER_CHANNEL_ID
    );
    if (channel) await channel.send({ embeds: [embed] });

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

/* ============================
   Receipt (LOCKED)
   ============================ */
app.get("/receipt", (req, res) => {
  const { order, token } = req.query;
  const data = orders.get(order);

  if (!data || token !== data.token) {
    return res.status(403).send("Unauthorized");
  }

  res.send(`
    <html>
    <head>
      <title>Verify Order</title>
      <style>
        body { background:#0f0f12;color:white;font-family:Inter,Arial;text-align:center;padding:60px }
        input,button { padding:12px;border-radius:6px;border:none }
        button { background:#5865F2;color:white;cursor:pointer }
      </style>
    </head>
    <body>
      <h1>🔐 Verify Your Order</h1>
      <p>Email used at checkout</p>
      <p style="opacity:.6">${maskEmail(data.email)}</p>

      <form method="POST" action="/verify">
        <input type="hidden" name="order" value="${order}">
        <input type="hidden" name="token" value="${token}">
        <input type="email" name="email" required placeholder="you@example.com">
        <br><br>
        <button>Verify</button>
      </form>
    </body>
    </html>
  `);
});

/* ============================
   Email Verification
   ============================ */
app.post("/verify", (req, res) => {
  const { order, token, email } = req.body;
  const data = orders.get(order);

  if (!data || token !== data.token) {
    return res.status(403).send("Unauthorized");
  }

  if (email.toLowerCase() !== data.email.toLowerCase()) {
    return res.status(403).send("Email does not match order");
  }

  res.redirect(`/receipt-final?order=${order}&token=${token}`);
});

/* ============================
   Final Receipt
   ============================ */
app.get("/receipt-final", (req, res) => {
  const { order, token } = req.query;
  const d = orders.get(order);

  if (!d || token !== d.token) {
    return res.status(403).send("Unauthorized");
  }

  res.send(`
    <html>
    <head>
      <title>Order Receipt</title>
      <style>
        body { background:#0f0f12;color:white;font-family:Inter,Arial;padding:60px }
        .box { max-width:600px;margin:auto;background:#18181d;padding:30px;border-radius:12px }
        a { display:inline-block;margin-top:20px;padding:12px 20px;border-radius:6px;background:#5865F2;color:white;text-decoration:none }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ Order Confirmed</h1>
        <p><strong>Product:</strong> ${d.product}</p>
        <p><strong>Quantity:</strong> ${d.quantity}</p>
        <p><strong>Roblox:</strong> ${d.roblox}</p>
        <p><strong>Total:</strong> £${(d.totalGBP / 100).toFixed(2)}</p>
        <p><strong>Status:</strong> ${d.paid ? "Paid" : "Pending"}</p>
        <p><strong>Order ID:</strong> ${order}</p>

        <a href="https://discord.gg/PRmy2F3gAp">Join Discord</a>
      </div>
    </body>
    </html>
  `);
});

/* ============================
   Start Server
   ============================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});
