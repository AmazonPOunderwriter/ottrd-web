import { getServerSession } from "next-auth";
import Stripe from "stripe";
import { supabase, PLANS } from "../../../lib/db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function POST(request) {
  try {
    const session = await getServerSession();
    if (!session?.user?.email) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { plan, interval } = await request.json();

    if (!PLANS[plan]) {
      return Response.json({ error: "Invalid plan" }, { status: 400 });
    }

    const planConfig = PLANS[plan];
    const priceId = interval === "annual"
      ? planConfig.stripePriceAnnual
      : planConfig.stripePriceMonthly;

    if (!priceId) {
      return Response.json({ error: "Price not configured" }, { status: 500 });
    }

    // Get or create Stripe customer
    const { data: dbUser } = await supabase
      .from("users")
      .select("id, stripe_customer_id")
      .eq("email", session.user.email)
      .single();

    let customerId = dbUser?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: session.user.email,
        name: session.user.name,
        metadata: { userId: dbUser.id },
      });
      customerId = customer.id;

      await supabase
        .from("users")
        .update({ stripe_customer_id: customerId })
        .eq("id", dbUser.id);
    }

    // Create checkout session
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.NEXTAUTH_URL}/dashboard?checkout=success`,
      cancel_url: `${process.env.NEXTAUTH_URL}/pricing?checkout=canceled`,
      metadata: {
        userId: dbUser.id,
        plan: plan,
        interval: interval,
      },
      subscription_data: {
        metadata: {
          userId: dbUser.id,
          plan: plan,
        },
      },
    });

    return Response.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Checkout error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
