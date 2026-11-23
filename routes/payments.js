import express from "express";

export default function paymentsRouter(paymentsCollection, stripe, verifyToken) {
  const router = express.Router();

  // Read-only: retrieve a Stripe session for the authenticated vendor who owns it.
  // Never writes to DB, never activates premium.
  router.post("/checkout-verify", verifyToken, async (req, res) => {
    try {
      if (!req.user || req.user.role !== "vendor") {
        return res.status(403).send({ message: "Forbidden" });
      }

      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).send({ message: "sessionId required" });

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // vendor ownership: metadata.vendorId must match the logged-in vendor
      if (session.metadata?.vendorId !== req.user._id.toString()) {
        return res.status(403).send({ message: "Forbidden" });
      }

      if (session.status !== "complete" || session.payment_status !== "paid") {
        return res.status(400).send({ message: "Payment is not completed" });
      }

      // read-only: return session info only
      res.send({
        message: "Payment verified",
        result: {
          sessionId: session.id,
          status: session.status,
          payment_status: session.payment_status,
          customer_email: session.customer_email,
          amount: session.amount_total,
          currency: session.currency,
        },
      });
    } catch (error) {
      console.error("Payment verification error:", error);
      res.status(500).send({ message: "Failed to verify payment", error: error.message });
    }
  });

  return router;
}
