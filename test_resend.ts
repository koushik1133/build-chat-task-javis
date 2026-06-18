// Test Resend email delivery
async function main() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = process.env.RESEND_FROM;

  console.log("RESEND_API_KEY present:", !!RESEND_API_KEY);
  console.log("RESEND_API_KEY prefix:", RESEND_API_KEY?.slice(0, 10) + "...");
  console.log("RESEND_FROM:", RESEND_FROM);

  // 1. Check API key validity — list domains
  console.log("\n--- Checking API key validity (list domains) ---");
  const domainRes = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  const domainData = await domainRes.json().catch(() => ({}));
  console.log("Domains status:", domainRes.status);
  console.log("Domains response:", JSON.stringify(domainData, null, 2));

  // 2. Check API key validity — list API keys
  console.log("\n--- Checking API keys ---");
  const keyRes = await fetch("https://api.resend.com/api-keys", {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  const keyData = await keyRes.json().catch(() => ({}));
  console.log("API keys status:", keyRes.status);
  console.log("API keys response:", JSON.stringify(keyData, null, 2));

  // 3. Send a test email and log the FULL response
  console.log("\n--- Sending test email ---");
  const payload = {
    from: RESEND_FROM,
    to: ["delivered@resend.dev"],  // Resend's own test inbox - always works
    subject: "Javis Debug Test " + new Date().toISOString(),
    html: "<h1>Test</h1><p>If you see this, Resend is working.</p>",
  };
  console.log("Payload:", JSON.stringify(payload, null, 2));

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const sendData = await sendRes.json().catch(() => ({}));
  console.log("Send status:", sendRes.status);
  console.log("Send response:", JSON.stringify(sendData, null, 2));

  // 4. If we got an email ID, check its status
  if ((sendData as any).id) {
    console.log("\n--- Checking email status ---");
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.resend.com/emails/${(sendData as any).id}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    const statusData = await statusRes.json().catch(() => ({}));
    console.log("Email status:", JSON.stringify(statusData, null, 2));
  }
}

main().catch(console.error);
