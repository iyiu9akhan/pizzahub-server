import express from "express";

export default function paymentsRouter(paymentsCollection, stripe) {
  const router = express.Router();

  // payment verification API
  router.post("/checkout-verify", async (req, res) => {
    try {
      const { sessionId } = req.body;

      // retrieve Stripe Checkout Session
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent"],
      });

      // payment must be completed and paid
      if (session.status !== "complete" || session.payment_status !== "paid") {
        return res.status(400).send({
          message: "Payment is not completed",
        });
      }

      // check if payment already exists
      const existingPayment = await paymentsCollection.findOne({
        sessionId: session.id,
      });

      // return existing payment if already verified
      if (existingPayment) {
        return res.send({
          message: "Payment already verified",
          result: existingPayment,
        });
      }

      // payment information
      const payment = {
        sessionId: session.id,
        status: session.status,
        payment_status: session.payment_status,
        customer_email: session.customer_email,
        userId: session.metadata?.vendorId,
        payment_intent: session.payment_intent,
        amount: session.amount_total,
        currency: session.currency,
        createdAt: new Date(),
      };

      // insert payment into database
      const result = await paymentsCollection.insertOne(payment);

      res.send({
        message: "Payment verified successfully",
        result: {
          ...payment,
          _id: result.insertedId,
        },
      });
    } catch (error) {
      console.error("Payment verification error:", error);

      res.status(500).send({
        message: "Failed to verify payment",
        error: error.message,
      });
    }
  });

  return router;
}