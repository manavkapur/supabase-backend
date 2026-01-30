// Setup type definitions for Supabase Edge Runtime
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --------------------------------------------------
    // 🔐 1. Read Authorization header
    // --------------------------------------------------
    const authHeader =
      req.headers.get("authorization") ||
      req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // --------------------------------------------------
    // 👤 2. USER client (RLS enforced)
    // --------------------------------------------------
    const userSupabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await userSupabase.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid user" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const userId = user.id;

    // --------------------------------------------------
    // 🔑 3. ADMIN client (bypasses RLS)
    // --------------------------------------------------
    const adminSupabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!
    );

    // --------------------------------------------------
    // 🛒 4. Fetch active cart
    // --------------------------------------------------
    const { data: cart } = await userSupabase
      .from("carts")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "ACTIVE")
      .maybeSingle();

    if (!cart) throw new Error("No active cart found");

    // --------------------------------------------------
    // 📦 5. Fetch cart items
    // --------------------------------------------------
    const { data: items } = await userSupabase
      .from("cart_items")
      .select("quantity, products ( id, name, price )")
      .eq("cart_id", cart.id);

    if (!items || items.length === 0) {
      throw new Error("Cart is empty");
    }

    // --------------------------------------------------
    // 🧮 6. Calculate totals (₹ → paise)
    // --------------------------------------------------
    let subTotal = 0;
    for (const i of items) {
      subTotal += i.quantity * i.products.price;
    }

    const amountPaise = Math.round(subTotal * 100);

    // --------------------------------------------------
    // 🔁 7. Idempotency (existing CREATED order)
    // --------------------------------------------------
    const { data: existingOrder } = await adminSupabase
      .from("orders")
      .select("id, payment_gateway_order_id")
      .eq("user_id", userId)
      .eq("status", "CREATED")
      .maybeSingle();

    if (existingOrder?.payment_gateway_order_id) {
      return new Response(
        JSON.stringify({
          order_id: existingOrder.id,
          razorpay_order_id: existingOrder.payment_gateway_order_id,
          amount: amountPaise,
          currency: "INR",
          key: Deno.env.get("RAZORPAY_KEY_ID"),
        }),
        { headers: corsHeaders }
      );
    }

    // --------------------------------------------------
    // 📦 8. Create order (ADMIN)
    // --------------------------------------------------
    const { data: order, error: orderError } = await adminSupabase
      .from("orders")
      .insert({
        user_id: userId,
        sub_total: subTotal,
        discount_total: 0,
        grand_total: subTotal,
        payment_status: "CREATED",
        status: "CREATED",
      })
      .select()
      .single();

    if (orderError || !order) {
      throw new Error("Failed to create order");
    }

    // --------------------------------------------------
    // 📸 9. Snapshot order_items (ADMIN)
    // --------------------------------------------------
    const orderItems = items.map((i: any) => ({
      order_id: order.id,
      product_id: i.products.id,
      product_name: i.products.name,
      price: i.products.price,
      qty: i.quantity,
      item_total: i.quantity * i.products.price,
    }));

    await adminSupabase.from("order_items").insert(orderItems);

    // --------------------------------------------------
    // 💰 10. Create Razorpay order
    // --------------------------------------------------
    const razorpayRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          btoa(
            `${Deno.env.get("RAZORPAY_KEY_ID")}:${Deno.env.get(
              "RAZORPAY_KEY_SECRET"
            )}`
          ),
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `order_${order.id}`,
      }),
    });

    const razorpayOrder = await razorpayRes.json();

    if (!razorpayRes.ok) {
      throw new Error("Razorpay order creation failed");
    }

    // --------------------------------------------------
    // 🧾 11. Create payment row (ADMIN) ✅ FIX
    // --------------------------------------------------
    await adminSupabase.from("payments").insert({
      order_id: order.id,
      razorpay_order_id: razorpayOrder.id,
      amount: amountPaise,
      status: "CREATED",
      raw_payload: razorpayOrder,
    });

    // --------------------------------------------------
    // 🔗 12. Update order with gateway order id
    // --------------------------------------------------
    await adminSupabase
      .from("orders")
      .update({
        payment_gateway_order_id: razorpayOrder.id,
      })
      .eq("id", order.id);

    // --------------------------------------------------
    // 🔒 13. Lock cart
    // --------------------------------------------------
    await adminSupabase
      .from("carts")
      .update({ status: "CONVERTED" })
      .eq("id", cart.id);

    // --------------------------------------------------
    // ✅ 14. Return response
    // --------------------------------------------------
    return new Response(
      JSON.stringify({
        order_id: order.id,
        razorpay_order_id: razorpayOrder.id,
        amount: amountPaise,
        currency: "INR",
        key: Deno.env.get("RAZORPAY_KEY_ID"),
      }),
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 400,
      headers: corsHeaders,
    });
  }
});
