// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
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
    // 1. Parse body
    // -----------------------------
    const { items } = await req.json();

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "Items required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // -----------------------------
    // 2. Verify user
    // -----------------------------
    const authHeader =
  req.headers.get("authorization") ||
  req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");

    const supabase = createClient(
      Deno.env.get("SB_URL")!,
      Deno.env.get("SB_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) throw new Error("Invalid user");

    const userId = user.id;

    // -----------------------------
    // 3. Get or create active cart
    // -----------------------------
    let { data: cart } = await supabase
      .from("carts")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "ACTIVE")
      .single();

    if (!cart) {
      const { data: newCart, error } = await supabase
        .from("carts")
        .insert({ user_id: userId, status: "ACTIVE" })
        .select()
        .single();

      if (error) throw new Error("Failed to create cart");
      cart = newCart;
    }

    // -----------------------------
    // 4. Merge items
    // -----------------------------
    for (const item of items) {
      if (!item.product_id || !item.quantity) continue;

      const { data: existing } = await supabase
        .from("cart_items")
        .select("id, quantity")
        .eq("cart_id", cart.id)
        .eq("product_id", item.product_id)
        .single();

      if (existing) {
        await supabase
          .from("cart_items")
          .update({ quantity: existing.quantity + item.quantity })
          .eq("id", existing.id);
      } else {
        await supabase.from("cart_items").insert({
          cart_id: cart.id,
          product_id: item.product_id,
          quantity: item.quantity,
        });
      }
    }

    // -----------------------------
    // 5. Return merged cart
    // -----------------------------
    const { data: mergedItems } = await supabase
      .from("cart_items")
      .select("product_id, quantity")
      .eq("cart_id", cart.id);

    return new Response(
      JSON.stringify({
        cart_id: cart.id,
        items: mergedItems,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 400,
      headers: corsHeaders,
    });
  }
});


/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/merge-cart' \
    --header 'Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjIwODUwNDI1MDd9.5gKMTwb36tnAdlvdicTAJmlMRr1AiQUP79V5Bz3ITrcAIwTII-G2R512rsMzCubZ1WJDcxVLRt14NGGSCGJGMQ' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
