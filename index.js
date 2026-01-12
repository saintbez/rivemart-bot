require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const app = express();
app.use(bodyParser.json());

const orders = new Map();

/* ---------------- HELPERS ---------------- */

function normalizeMoney(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && !isNaN(v)) {
      return (Number(v) / 100).toFixed(2);
    }
  }
  return "0.00";
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
    // 🔍 LOG FULL WEBHOOK DATA FOR DEBUGGING
    console.log("📦 FULL WEBHOOK DATA:", JSON.stringify(req.body, null, 2));
    
    const { event, data } = req.body;

    if (!["order.completed", "order.paid"].includes(event)) {
      return res.json({ ignored: true });
    }

    const orderId = String(data.id);
    const variant = data.product_variants?.[0] || {};

    const product = variant.product_title || data.product?.title || "Unknown Product";
    const quantity = variant.quantity || 1;

    // 🔧 IMPROVED ROBLOX USERNAME EXTRACTION
    let roblox = "Not provided";
    
    // Check custom fields first
    if (data.custom_fields) {
      roblox = data.custom_fields["Roblox Username"] ||
               data.custom_fields["roblox_username"] ||
               data.custom_fields["roblox"] ||
               data.custom_fields["Roblox"] ||
               roblox;
    }
    
    // Check additional information
    if (roblox === "Not provided" && variant.additional_information) {
      const robloxField = variant.additional_information.find(f =>
        f.key && f.key.toLowerCase().includes("roblox")
      );
      if (robloxField) roblox = robloxField.value;
    }

    const email = data.customer_information?.email || 
                  data.customer?.email || 
                  "Hidden";
    
    const country = data.customer_information?.country || 
                    data.customer?.country || 
                    "Unknown";

    // 🔧 IMPROVED DISCORD USERNAME EXTRACTION
    let discordUser = "Not provided";
    
    if (data.customer_information?.discord) {
      discordUser = data.customer_information.discord;
    } else if (data.customer_information?.discord_username) {
      discordUser = data.customer_information.discord_username;
    } else if (data.custom_fields) {
      discordUser = data.custom_fields["Discord Username"] ||
                    data.custom_fields["discord"] ||
                    data.custom_fields["Discord"] ||
                    discordUser;
    }

    const coupon = data.coupon?.code || "None";

    // 🔧 IMPROVED PRICE EXTRACTION
    let totalUSD = "0.00";
    let totalGBP = "0.00";

    // Try formatted display prices first (already in correct format)
    if (data.total_display) {
      totalUSD = data.total_display.replace(/[^0-9.]/g, "");
    } else if (data.price_display) {
      totalUSD = data.price_display.replace(/[^0-9.]/g, "");
    } else {
      // Fall back to cent values
      totalUSD = normalizeMoney(
        data.total_price_usd,
        data.price?.total_usd,
        data.price?.total,
        data.total_price,
        data.subtotal
      );
    }

    // Try GBP formatted display
    if (data.total_display_gbp) {
      totalGBP = data.total_display_gbp.replace(/[^0-9.]/g, "");
    } else {
      totalGBP = normalizeMoney(
        data.total_price_gbp,
        data.price?.total_gbp
      );
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

<p><b>Order ID:</b> ${r.orderId}</p>
<p><b>Product:</b> ${r.product}</p>
<p><b>Quantity:</b> ${r.quantity}</p>
<p><b>Roblox:</b> ${r.roblox}</p>
<p><b>Discord:</b> ${r.discordUser}</p>
<p><b>Email:</b> ${maskEmail(r.email)}</p>
<p><b>Country:</b> ${r.country}</p>
<p><b>Total Paid:</b> £${r.totalGBP} / $${r.totalUSD}</p>

<div class="box delivery">
<b>🚚 Delivery</b>
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