import Stripe from "stripe";
import { supabase } from "../../../lib/db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;
      const interval = session.metadata?.interval || "monthly";

      if (userId && plan) {
        await supabase.from("users").update({
          plan: plan,
          billing_interval: interval,
          stripe_subscription_id: session.subscription,
          subscription_status: "active",
          updated_at: new Date().toISOString(),
        }).eq("id", userId);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;

      if (userId) {
        const status = sub.status === "active" || sub.status === "trialing"
          ? "active" : sub.status;

        await supabase.from("users").update({
          subscription_status: status,
          updated_at: new Date().toISOString(),
        }).eq("id", userId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;

      if (userId) {
        await supabase.from("users").update({
          plan: "none",
          subscription_status: "canceled",
          stripe_subscription_id: null,
          updated_at: new Date().toISOString(),
        }).eq("id", userId);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      const { data: user } = await supabase
        .from("users")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (user) {
        await supabase.from("users").update({
          subscription_status: "past_due",
          updated_at: new Date().toISOString(),
        }).eq("id", user.id);
      }
      break;
    }
  }

  return Response.json({ received: true });
}
