const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");

dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.nkuntqh.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("parcelDB");
    const parcelsCollection = database.collection("parcels");
    const paymentsCollection = database.collection("payments");

    await parcelsCollection.createIndex({ trackingId: 1 }, { unique: true });

    app.get("/parcels", async (req, res) => {
      const cursor = parcelsCollection.find();
      const parcels = await cursor.toArray();
      res.send(parcels);
    });

    // Parcels api
    app.get("/parcels/user", async (req, res) => {
      const { email } = req.query;

      if (!email) {
        return res
          .status(400)
          .send({ error: "Email query parameter is required" });
      }

      const cursor = parcelsCollection
        .find({ "createdBy.email": email })
        .sort({ createdAtISO: -1 });

      const parcels = await cursor.toArray();
      res.send(parcels);
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error("Get parcel error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    //payment get
    app.get("/payments", async (req, res) => {
      try {
        const userEmail = req.query.email; // ideally from req.user.email
        if (!userEmail)
          return res.status(400).send({ message: "email required" });

        const payments = await paymentsCollection
          .find({ userEmail })
          .sort({ createdAt: -1 }) // ✅ latest first
          .toArray();

        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    // Track parcel by trackingId (public id)
    app.get("/parcels/track/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;

        if (!trackingId) {
          return res.status(400).send({ message: "trackingId is required" });
        }

        const parcel = await parcelsCollection.findOne({ trackingId });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        // Return only what's needed for tracking UI
        res.send({
          _id: parcel._id,
          trackingId: parcel.trackingId,
          parcelTitle: parcel.parcelTitle,
          parcelType: parcel.parcelType,
          paymentType: parcel.paymentType,
          deliveryCost: parcel.deliveryCost,
           codAmount: parcel.codAmount,

          senderRegion: parcel.senderRegion,
          senderCenter: parcel.senderCenter,
          receiverRegion: parcel.receiverRegion,
          receiverCenter: parcel.receiverCenter,

          status: parcel.status,
          statusHistory: parcel.statusHistory || [],
          createdAtISO: parcel.createdAtISO,
        });
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });


    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      console.log("New parcel added:", parcel);
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // payment

    app.post("/create-payment-intent", async (req, res) => {
      const { amountInCents } = req.body;

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    //Update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, paymentIntentId, userName, userEmail } = req.body;

        if (!parcelId || !paymentIntentId || !userEmail) {
          return res
            .status(400)
            .send({ message: "parcelId, paymentIntentId, userEmail required" });
        }

        // 1) Load parcel from DB
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });
        if (!parcel)
          return res.status(404).send({ message: "Parcel not found" });
        // 2) Verify payment with Stripe (IMPORTANT)
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== "succeeded") {
          return res
            .status(400)
            .send({ message: "Payment not succeeded", status: pi.status });
        }

        // 3) Verify amount matches parcel (IMPORTANT)
        const expectedAmountInCents = Math.round((parcel.codAmount || 0) * 100);
        if (pi.amount !== expectedAmountInCents) {
          return res.status(400).send({
            message: "Amount mismatch",
            expected: expectedAmountInCents,
            got: pi.amount,
          });
        }

        // 4) Update parcel -> paid
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentType: "paid",
              paidAt: new Date(),
              transactionId: pi.id,
            },
          },
        );

        // 5) Insert payment history (one per parcel)
        const paymentDoc = {
          parcelId: new ObjectId(parcelId),
          userEmail,
          userName: userName || "",
          parcelName: parcel.parcelTitle,

          amount: pi.amount / 100,
          amountInCents: pi.amount,
          currency: pi.currency,

          provider: "stripe",
          paymentIntentId: pi.id,
          paymentMethod:
            (pi.payment_method_types && pi.payment_method_types[0]) || "card",
          status: pi.status,

          createdAt: new Date(),
        };

        // If you used unique index on parcelId, this prevents duplicates
        await paymentsCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded & parcel marked paid",
          parcelUpdated: updateResult.modifiedCount === 1,
          payment: paymentDoc,
        });
      } catch (err) {
        // Handle duplicate insert (if user calls API twice)
        if (String(err?.code) === "11000") {
          return res
            .status(409)
            .send({ message: "Payment already recorded for this parcel" });
        }
        res.status(500).send({ message: err.message });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Fast Trust Server is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
