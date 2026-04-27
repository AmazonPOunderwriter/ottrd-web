import { getServerSession } from "next-auth";
import { getUserPlan, PLANS } from "../../../lib/db";
import { supabase } from "../../../lib/db";

export async function GET() {
  try {
    const session = await getServerSession();
    if (!session?.user?.email) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: dbUser } = await supabase
      .from("users")
      .select("id")
      .eq("email", session.user.email)
      .single();

    if (!dbUser) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    const userPlan = await getUserPlan(dbUser.id);

    // Get recent analyses
    const { data: recentAnalyses } = await supabase
      .from("analyses")
      .select("*")
      .eq("user_id", dbUser.id)
      .order("created_at", { ascending: false })
      .limit(10);

    return Response.json({
      plan: userPlan?.plan || "none",
      planName: userPlan?.planDetails?.name || "No Plan",
      skuLimit: userPlan?.planDetails?.skuLimit || 0,
      skusUsed: userPlan?.skusUsedThisMonth || 0,
      skusRemaining: userPlan?.skusRemaining || 0,
      subscriptionStatus: userPlan?.subscription_status || "inactive",
      billingInterval: userPlan?.billing_interval || "monthly",
      recentAnalyses: recentAnalyses || [],
    });
  } catch (err) {
    console.error("Usage API error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
