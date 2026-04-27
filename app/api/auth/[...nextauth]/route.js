import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import EmailProvider from "next-auth/providers/email";
import { supabase } from "../../../../lib/db";

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!supabase) return true;

      // Upsert user in our database
      const { data: existingUser } = await supabase
        .from("users")
        .select("id")
        .eq("email", user.email)
        .single();

      if (!existingUser) {
        await supabase.from("users").insert({
          email: user.email,
          name: user.name,
          image: user.image,
        });
      }

      return true;
    },
    async session({ session }) {
      if (!supabase || !session?.user?.email) return session;

      // Attach user ID and plan info to session
      const { data: dbUser } = await supabase
        .from("users")
        .select("id, plan, subscription_status, stripe_customer_id")
        .eq("email", session.user.email)
        .single();

      if (dbUser) {
        session.user.id = dbUser.id;
        session.user.plan = dbUser.plan;
        session.user.subscriptionStatus = dbUser.subscription_status;
        session.user.stripeCustomerId = dbUser.stripe_customer_id;
      }

      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.email = user.email;
      }
      return token;
    },
  },
  pages: {
    signIn: "/auth",
  },
  secret: process.env.NEXTAUTH_SECRET,
});

export { handler as GET, handler as POST };
