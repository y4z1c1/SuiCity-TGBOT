import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

dotenv.config();

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

const provider = new SuiClient({ url: getFullnodeUrl("mainnet") });

// Retry parameters
const MAX_RETRIES = 10;
const BACKOFF_TIME = 1500; // 1.5 seconds

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(fetchFn, ...args) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      console.log(`Attempt ${attempt + 1} to fetch data from provider...`);
      const result = await fetchFn(...args);
      console.log(`Fetch succeeded on attempt ${attempt + 1}.`);
      return result;
    } catch (error) {
      if (error.status === 429) {
        attempt++;
        console.warn(
          `Received 429 Too Many Requests. Attempt ${attempt}/${MAX_RETRIES}. Waiting ${BACKOFF_TIME}ms before retrying...`
        );
        await delay(BACKOFF_TIME);
      } else {
        console.error("Non-429 error encountered during fetch:", error);
        throw error;
      }
    }
  }
  throw new Error(
    `Max retries reached for fetchWithRetry after ${MAX_RETRIES} attempts`
  );
}

async function getObjectWithRetry(id) {
  console.log(`Fetching object details for ID: ${id}`);
  return await fetchWithRetry(provider.getObject.bind(provider), {
    id,
    options: { showContent: true, showType: true },
  });
}

async function updateNftDataField(collection) {
  console.log("Fetching all documents from the collection...");
  const documents = await collection.find().toArray();
  console.log(`Found ${documents.length} documents to process.`);

  const updates = [];

  for (const doc of documents) {
    const nftId = doc.nft;
    if (!nftId) {
      console.log(`Document with ID ${doc._id} has no NFT field. Skipping...`);
      continue;
    }

    console.log(`Processing document with ID ${doc._id}, NFT: ${nftId}`);
    try {
      const nftData = await getObjectWithRetry(nftId);
      updates.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { nftData } },
        },
      });
      console.log(`Fetched and prepared update for NFT ${nftId}.`);
    } catch (error) {
      console.error(
        `Error fetching NFT data for document ID ${doc._id}, NFT ${nftId}:`,
        error
      );
    }
  }

  if (updates.length > 0) {
    console.log(`Performing bulk write for ${updates.length} updates...`);
    await collection.bulkWrite(updates);
    console.log("Bulk update completed successfully.");
  } else {
    console.log("No updates were needed.");
  }
}

async function main() {
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("Connected to MongoDB successfully.");

    const database = client.db("twitter_bindings");
    const collection = database.collection("bindings");

    console.log("Starting to update NFT data field...");
    await updateNftDataField(collection);
    console.log("NFT data field update process completed.");
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    console.log("Closing MongoDB connection...");
    await client.close();
    console.log("MongoDB connection closed. Script completed.");
  }
}

main().catch(console.error);
