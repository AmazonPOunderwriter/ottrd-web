import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("Supabase env vars not set - database features disabled");
}

export const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Plan definitions
export const PLANS = {
  starter: {
    name: "Starter",
    monthlyPrice: 49,
    annualPrice: 529,
    skuLimit: 2500,
    stripePriceMonthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    stripePriceAnnual: process.env.STRIPE_PRICE_STARTER_ANNUAL,
  },
  professional: {
    name: "Professional",
    monthlyPrice: 129,
    annualPrice: 1393,
    skuLimit: 15000,
    stripePriceMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    stripePriceAnnual: process.env.STRIPE_PRICE_PRO_ANNUAL,
  },
  enterprise: {
    name: "Enterprise",
    monthlyPrice: 299,
    annualPrice: 3229,
    skuLimit: 50000,
    stripePriceMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
    stripePriceAnnual: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL,
  },
};

// Get user's current plan and usage
export async function getUserPlan(userId) {
  if (!supabase) return null;

  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", userId)
    .single();

  if (!user) return null;

  // Get current month usage
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data: usage } = await supabase
    .from("usage")
    .select("skus_analyzed")
    .eq("user_id", userId)
    .gte("created_at", monthStart);

  const totalSkus = (usage || []).reduce((sum, u) => sum + u.skus_analyzed, 0);
  const plan = PLANS[user.plan] || null;

  return {
    ...user,
    planDetails: plan,
    skusUsedThisMonth: totalSkus,
    skusRemaining: plan ? Math.max(0, plan.skuLimit - totalSkus) : 0,
  };
}

// Record usage
export async function recordUsage(userId, skuCount) {
  if (!supabase) return;

  await supabase.from("usage").insert({
    user_id: userId,
    skus_analyzed: skuCount,
    created_at: new Date().toISOString(),
  });
}

// Check if user can run analysis
export async function canRunAnalysis(userId, skuCount) {
  const userPlan = await getUserPlan(userId);
  if (!userPlan || !userPlan.planDetails) return { allowed: false, reason: "No active plan" };
  if (userPlan.skusRemaining < skuCount) {
    return {
      allowed: false,
      reason: `You need ${skuCount} SKUs but only have ${userPlan.skusRemaining} remaining this month. Upgrade your plan for more.`,
    };
  }
  return { allowed: true };
}
