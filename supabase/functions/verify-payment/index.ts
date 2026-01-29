// Setup type definitions for Supabase Edge Runtime
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function verifySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
) {
  const payload = `${orderId}|${paymentId}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );

  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return expected === signature;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // -----------------------------
    // 1. Parse body
    // -----------------------------
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      await req.json();

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      throw new Error("Missing payment verification fields");
    }

    // -----------------------------
    // 2. Init Supabase (service role)
    // -----------------------------
    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!
    );

    // -----------------------------
    // 3. Fetch payment row
    // -----------------------------
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*, orders(*)")
      .eq("razorpay_order_id", razorpay_order_id)
      .single();

    if (payErr || !payment) throw new Error("Payment record not found");

    if (payment.status === "PAID") {
      return new Response(
        JSON.stringify({ success: true, message: "Already verified" }),
        { headers: corsHeaders }
      );
    }

    // -----------------------------
    // 4. Verify Razorpay signature
    // -----------------------------
    const valid = await verifySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      Deno.env.get("RAZORPAY_KEY_SECRET")!
    );

    if (!valid) throw new Error("Invalid Razorpay signature");

    // -----------------------------
    // 5. Update payment row
    // -----------------------------
    await supabase
      .from("payments")
      .update({
        razorpay_payment_id,
        status: "PAID",
      })
      .eq("id", payment.id);

    // -----------------------------
    // 6. Update order row
    // -----------------------------
    await supabase
      .from("orders")
      .update({
        payment_status: "PAID",
        status: "CONFIRMED",
      })
      .eq("id", payment.order_id);

    // -----------------------------
    // ✅ 7. Done
    // -----------------------------
    return new Response(
      JSON.stringify({
        success: true,
        order_id: payment.order_id,
      }),
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e.message || String(e) }),
      { status: 400, headers: corsHeaders }
    );
  }
});
