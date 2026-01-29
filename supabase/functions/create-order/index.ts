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
    // -----------------------------
    // 🔐 1. Verify user manually
    // -----------------------------
    const authHeader =
      req.headers.get("authorization") ||
      req.headers.get("Authorization");

    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!,
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid user" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const userId = user.id;

    // -----------------------------
    // 🛒 2. Get active cart
    // -----------------------------
    const { data: carts, error: cartError } = await supabase
      .from("carts")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "ACTIVE")
      .limit(1);

    if (cartError || !carts || carts.length === 0) {
      throw new Error("No active cart found");
    }

    const cartId = carts[0].id;

    // -----------------------------
    // 📦 3. Get cart items
    // -----------------------------
    const { data: items, error: itemsError } = await supabase
      .from("cart_items")
      .select("quantity, products ( id, name, price )")
      .eq("cart_id", cartId);

    if (itemsError || !items || items.length === 0) {
      throw new Error("Cart is empty");
    }

    // -----------------------------
    // 🧮 4. Calculate totals
    // -----------------------------
    let subTotal = 0;

    items.forEach((i: any) => {
      subTotal += i.quantity * i.products.price;
    });

    // -----------------------------
    // 📦 5. Create order in DB
    // -----------------------------
    const { data: orders, error: orderError } = await supabase
      .from("orders")
      .insert({
        user_id: userId,
        sub_total: subTotal,
        discount_total: 0,
        grand_total: subTotal,
        status: "CREATED",
        payment_status: "CREATED",
      })
      .select()
      .single();

    if (orderError || !orders) {
      console.error("ORDER ERROR:", orderError);
      throw new Error("Failed to create order");
    }

    const order = orders;

    // -----------------------------
    // 📸 6. Snapshot cart → order_items
    // -----------------------------
    const orderItems = items.map((i: any) => ({
      order_id: order.id,
      product_id: i.products.id,
      product_name: i.products.name,
      price: i.products.price,
      qty: i.quantity,
      item_total: i.quantity * i.products.price,
    }));

    const { error: orderItemsError } = await supabase
      .from("order_items")
      .insert(orderItems);

    if (orderItemsError) {
      console.error("ORDER ITEMS ERROR:", orderItemsError);
      throw new Error("Failed to snapshot order items");
    }

    // -----------------------------
    // 🔒 7. Lock the cart
    // -----------------------------
    const { error: cartLockError } = await supabase
      .from("carts")
      .update({ status: "CONVERTED" })
      .eq("id", cartId);

    if (cartLockError) {
      console.error("CART LOCK ERROR:", cartLockError);
      throw new Error("Failed to lock cart");
    }

    // -----------------------------
    // 💰 8. Create Razorpay order
    // -----------------------------
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
        amount: subTotal, // paise
        currency: "INR",
        receipt: `order_${order.id}`,
      }),
    });

    const razorpayOrder = await razorpayRes.json();

    if (!razorpayRes.ok) {
      console.error("RAZORPAY ERROR:", razorpayOrder);
      throw new Error("Razorpay order creation failed");
    }

    // -----------------------------
    // 🧾 9. Save payment row
    // -----------------------------
    const { error: paymentError } = await supabase.from("payments").insert({
      order_id: order.id,
      razorpay_order_id: razorpayOrder.id,
      amount: subTotal,
      status: "CREATED",
    });

    if (paymentError) {
      console.error("PAYMENT INSERT ERROR:", paymentError);
      throw new Error("Failed to create payment row");
    }

    // -----------------------------
    // ✅ 10. Return to app
    // -----------------------------
    return new Response(
      JSON.stringify({
        order_id: order.id,
        razorpay_order_id: razorpayOrder.id,
        amount: subTotal,
        currency: "INR",
        key: Deno.env.get("RAZORPAY_KEY_ID"),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 400,
      headers: corsHeaders,
    });
  }
});
