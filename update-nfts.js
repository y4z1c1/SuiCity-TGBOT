import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import fs from "fs/promises";
import pLimit from "p-limit";
import nodemailer from "nodemailer";

dotenv.config();

// This can be run in Render cron jobs by setting a cron job in Render Dashboard
// that runs: `node update-nfts.js` at the desired interval.

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

const provider = new SuiClient({ url: getFullnodeUrl("mainnet") });
const ADDRESSES = {
  NFT_TYPE:
    "0x5b9b4cd82aee3d5a942eebe9c2da38f411d82bfdfea1204f2486e45b5868b44f::nft::City",
};

// Limit concurrency to help prevent 429 errors
const limit = pLimit(2);

// Retry parameters for handling 429 errors
const MAX_RETRIES = 5;
const BACKOFF_TIME = 3000; // 3 seconds delay before retry

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

async function generateRefNumbers(collection, users) {
  console.log("Generating reference numbers...");
  const existingRefs = await collection
    .find({ refNumber: { $exists: true } }, { projection: { refNumber: 1 } })
    .toArray();
  console.log(`Found ${existingRefs.length} users with existing refNumbers.`);

  const usedRefNumbers = new Set(existingRefs.map((doc) => doc.refNumber));
  let lowerBound = 20000;
  let upperBound = 100000;

  const updates = [];
  for (const user of users) {
    if (!user.refNumber) {
      console.log(
        `User ${user.walletAddress || user._id} has no refNumber. Generating...`
      );
      let refNumber;
      let attemptCount = 0;
      while (true) {
        refNumber =
          Math.floor(Math.random() * (upperBound - lowerBound + 1)) +
          lowerBound;
        if (!usedRefNumbers.has(refNumber)) {
          usedRefNumbers.add(refNumber);
          console.log(
            `Assigned refNumber ${refNumber} to user ${
              user.walletAddress || user._id
            }`
          );
          break;
        } else {
          attemptCount++;
          console.log(`RefNumber ${refNumber} already in use, retrying...`);
        }
        if (attemptCount > 100) {
          upperBound += 100000;
          attemptCount = 0;
          console.log(
            "Reached 100 attempts, increasing upper bound for refNumber generation."
          );
        }
      }
      updates.push({
        updateOne: {
          filter: { _id: user._id },
          update: { $set: { refNumber } },
        },
      });
    }
  }

  if (updates.length > 0) {
    console.log(
      `Performing bulk update for ${updates.length} new refNumbers...`
    );
    await collection.bulkWrite(updates);
    console.log("Bulk refNumber assignment completed.");
  } else {
    console.log("No new refNumbers were needed.");
  }

  return updates.length;
}

async function getOwnedObjectsWithRetry(owner, cursor) {
  console.log(
    `Fetching owned objects for owner: ${owner}, cursor: ${cursor || "none"}`
  );
  return await fetchWithRetry(provider.getOwnedObjects.bind(provider), {
    owner: String(owner),
    cursor,
    options: { showType: true },
  });
}

async function getObjectWithRetry(id, options) {
  console.log(`Fetching object details for ID: ${id}`);
  return await fetchWithRetry(provider.getObject.bind(provider), {
    id,
    options,
  });
}

async function fetchNftFromWalletCached(provider, walletAddress, nftCache) {
  if (nftCache[walletAddress] !== undefined) {
    console.log(
      `NFT data cached for user ${walletAddress}, using cached data.`
    );
    return nftCache[walletAddress];
  }

  console.log(`Fetching NFTs from wallet: ${walletAddress}`);
  const allObjects = [];
  let lastObject = null;

  while (true) {
    const object = await getOwnedObjectsWithRetry(
      walletAddress,
      lastObject?.data?.[lastObject.data.length - 1]?.data?.objectId || null
    );

    console.log(
      `Fetched ${object.data.length} objects for user ${walletAddress}.`
    );
    allObjects.push(...object.data);
    if (object.data.length === 0 || !object.nextCursor) {
      console.log(`No more objects to fetch for user ${walletAddress}.`);
      break;
    }
    lastObject = object;
  }

  const nftObject = allObjects.find(
    (nft) => String(nft.data?.type) === ADDRESSES.NFT_TYPE
  );
  if (!nftObject) {
    console.log(`No matching NFT found for user ${walletAddress}`);
    nftCache[walletAddress] = null;
    return null;
  }

  console.log(
    `Found NFT object for user ${walletAddress}: ${nftObject.data.objectId}`
  );
  const nftData = await getObjectWithRetry(nftObject.data.objectId, {
    showContent: true,
    showType: true,
  });

  console.log(
    `Fetched NFT details for ${walletAddress}, NFT ID: ${nftObject.data.objectId}`
  );
  nftCache[walletAddress] = nftData;
  return nftData;
}

async function updateNftFieldsAndWalletIds(collection, provider, users) {
  console.log("Updating NFT fields and wallet IDs where necessary...");
  const nftCache = {};
  const validUsers = users.filter((u) => u.walletAddress);

  console.log(
    `Processing NFT updates for ${validUsers.length} users with wallet addresses...`
  );
  const results = await Promise.all(
    validUsers.map((user) =>
      limit(async () => {
        const fetchedNft = await fetchNftFromWalletCached(
          provider,
          user.walletAddress,
          nftCache
        );
        return { user, fetchedNft };
      })
    )
  );

  const updates = [];
  let walletIdUpdatedCount = 0;
  let nftFieldUpdatedCount = 0;
  for (const { user, fetchedNft } of results) {
    if (!fetchedNft) {
      console.log(
        `No NFT found for user ${user.walletAddress}, skipping update.`
      );
      continue;
    }

    const fetchedNftId = fetchedNft?.data?.objectId;
    const nftName = fetchedNft?.data?.content?.fields?.name || "Unnamed NFT";
    const walletObjectId = fetchedNft?.data?.content?.fields?.wallet;

    if (!walletObjectId) {
      console.log(
        `No wallet field found in NFT for user ${user.walletAddress}, skipping update.`
      );
      continue;
    }

    // If the walletObjectId is already the same as user.walletId, no need to update walletId.
    if (user.walletId === walletObjectId) {
      console.log(
        `Wallet ID already correct for user ${user.walletAddress}. Checking NFT...`
      );

      // walletId is correct, so let's just update nft if needed
      if (!user.nft || user.nft !== fetchedNftId) {
        console.log(
          `Updating NFT field for user ${user.walletAddress} to ${fetchedNftId}`
        );
        updates.push({
          updateOne: {
            filter: { _id: user._id },
            update: { $set: { nft: fetchedNftId, nftName: nftName } },
          },
        });
        nftFieldUpdatedCount++;
      } else {
        console.log(`No NFT update needed for user ${user.walletAddress}.`);
      }
    } else {
      console.log(
        `Updating wallet ID for user ${user.walletAddress} from ${
          user.walletId || "none"
        } to ${walletObjectId}`
      );

      // walletId is different or not set, so update everything as before
      const updateDoc = { $set: { walletId: walletObjectId, nftName } };

      // Only update NFT field if necessary
      if (!user.nft || user.nft !== fetchedNftId) {
        console.log(
          `Also updating NFT for user ${user.walletAddress} to ${fetchedNftId}`
        );
        updateDoc.$set.nft = fetchedNftId;
        nftFieldUpdatedCount++;
      } else {
        console.log(
          `Wallet updated, but NFT already correct for user ${user.walletAddress}.`
        );
      }

      updates.push({
        updateOne: {
          filter: { _id: user._id },
          update: updateDoc,
        },
      });

      // If we changed the walletId, increment the walletIdUpdatedCount
      if (user.walletId !== walletObjectId) {
        walletIdUpdatedCount++;
      }
    }
  }

  if (updates.length > 0) {
    console.log(
      `Performing bulk write for ${updates.length} NFT/wallet updates...`
    );
    await collection.bulkWrite(updates);
    console.log("Bulk NFT/wallet updates completed.");
  } else {
    console.log("No NFT/wallet updates needed.");
  }

  return { walletIdUpdatedCount, nftFieldUpdatedCount };
}

async function fetchSityBalance(provider, walletId) {
  console.log(`Fetching SITY balance for walletId ${walletId}`);
  try {
    const walletObject = await getObjectWithRetry(walletId, {
      showContent: true,
    });
    const sityBalance = walletObject?.data?.content?.fields?.balance || 0;
    console.log(`Wallet ${walletId} has raw SITY balance: ${sityBalance}`);
    return sityBalance / 1e3;
  } catch (err) {
    console.error(`Error fetching SITY balance for wallet ${walletId}:`, err);
    return 0;
  }
}

function formatBalance(balance) {
  if (balance >= 1e6) return (balance / 1e6).toFixed(2) + "m";
  if (balance >= 1e3) return (balance / 1e3).toFixed(2) + "k";
  return balance.toFixed(2);
}

async function fetchAndStoreBalances(collection, provider) {
  console.log("Fetching balances for all users...");
  const users = await collection.find().toArray();
  console.log(`Found ${users.length} users to process for balances.`);

  const results = await Promise.all(
    users.map((user) =>
      limit(async () => {
        const sityBalance = user.walletId
          ? await fetchSityBalance(provider, user.walletId)
          : 0;
        console.log(
          `User ${user.walletAddress || user._id} SITY balance: ${sityBalance}`
        );
        return { user, sityBalance };
      })
    )
  );

  let totalBalance = 0;
  let totalPopulation = 0;

  for (const { user, sityBalance } of results) {
    totalBalance += sityBalance;
    totalPopulation += user.population || 0;
  }

  console.log(`Total SITY Balance across all users: ${totalBalance}`);
  console.log(`Total Population across all users: ${totalPopulation}`);

  const userBalances = results.map(({ user, sityBalance }) => {
    const percentageHolding =
      totalBalance > 0 ? (sityBalance / totalBalance) * 100 : 0;
    return {
      twitterId: user.twitterId,
      walletAddress: user.walletAddress,
      sityBalance: formatBalance(sityBalance),
      population: user.population || 0,
      percentageHolding: percentageHolding.toFixed(2) + "%",
    };
  });

  const parseBalance = (val) => {
    const num = parseFloat(val.replace(/k|m/g, ""));
    if (val.includes("m")) return num * 1e6;
    if (val.includes("k")) return num * 1e3;
    return num;
  };

  userBalances.sort(
    (a, b) => parseBalance(b.sityBalance) - parseBalance(a.sityBalance)
  );
  console.log("Sorted user balances by descending SITY balance.");

  const output = {
    totalPopulation,
    totalSityBalance: formatBalance(totalBalance),
    userBalances,
  };

  await fs.writeFile("balances.json", JSON.stringify(output, null, 2), "utf8");
  console.log("Wrote balances.json file.");

  await fs.writeFile(
    "sorted_balances.json",
    JSON.stringify(userBalances, null, 2),
    "utf8"
  );
  console.log("Wrote sorted_balances.json file.");

  return output;
}

async function sendEmail(summary) {
  console.log("Preparing to send email...");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, // e.g. "smtp.gmail.com"
    port: process.env.SMTP_PORT || 587,
    secure: false, // true if using 465
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const subject = "NFT & Wallet Update Summary";
  const text = `
Summary Report:
- Reference Numbers Generated: ${summary.refNumberGeneratedCount}
- Wallet IDs Updated: ${summary.walletIdUpdatedCount}
- NFT Fields Updated: ${summary.nftFieldUpdatedCount}
- Total Population: ${summary.totalPopulation}
- Total SITY Balance: ${summary.totalSityBalance}

Duplicate Wallet Addresses: ${
    summary.duplicateWalletAddresses.join(", ") || "None"
  }
Duplicate Telegram IDs: ${summary.duplicateTelegramIds.join(", ") || "None"}

Check attached sorted_balances.json for detailed balances report.
`;

  console.log("Sending email with summary and attachment...");
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.REPORT_EMAIL,
    subject,
    text,
    attachments: [
      {
        filename: "sorted_balances.json",
        path: "./sorted_balances.json",
      },
    ],
  });
  console.log("Email sent successfully!");
}

async function main() {
  let refNumberGeneratedCount = 0;
  let walletIdUpdatedCount = 0;
  let nftFieldUpdatedCount = 0;
  let duplicateWalletAddresses = [];
  let duplicateTelegramIds = [];
  let totalPopulation = 0;
  let totalSityBalance = "";

  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("Connected to MongoDB successfully.");

    const database = client.db("twitter_bindings");
    const collection = database.collection("bindings");

    console.log("Backing up the current 'bindings' collection...");
    await database
      .collection("bindings")
      .aggregate([{ $match: {} }, { $out: "bindings_backup" }])
      .toArray();
    console.log("Backup completed successfully.");

    console.log("Fetching all documents from 'bindings'...");
    const users = await collection.find().toArray();
    console.log(`Total users fetched: ${users.length}`);

    console.log("Generating unique reference numbers if needed...");
    refNumberGeneratedCount = await generateRefNumbers(collection, users);
    console.log(`Reference numbers generated: ${refNumberGeneratedCount}`);

    console.log("Updating NFT fields and wallet IDs...");
    const nftUpdateResult = await updateNftFieldsAndWalletIds(
      collection,
      provider,
      users
    );
    walletIdUpdatedCount = nftUpdateResult.walletIdUpdatedCount;
    nftFieldUpdatedCount = nftUpdateResult.nftFieldUpdatedCount;
    console.log(
      `Wallet IDs Updated: ${walletIdUpdatedCount}, NFT Fields Updated: ${nftFieldUpdatedCount}`
    );

    console.log("Checking for duplicate addresses and Telegram IDs...");
    const walletAddressCount = {};
    const telegramIdCount = {};
    for (const user of users) {
      if (user.walletAddress) {
        walletAddressCount[user.walletAddress] =
          (walletAddressCount[user.walletAddress] || 0) + 1;
      }
      if (user.telegramId) {
        telegramIdCount[user.telegramId] =
          (telegramIdCount[user.telegramId] || 0) + 1;
      }
    }

    duplicateWalletAddresses = Object.entries(walletAddressCount)
      .filter(([, count]) => count > 1)
      .map(([addr]) => addr);
    duplicateTelegramIds = Object.entries(telegramIdCount)
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    if (duplicateWalletAddresses.length > 0) {
      console.log(
        "Duplicate Wallet Addresses found:",
        duplicateWalletAddresses
      );
    } else {
      console.log("No duplicate wallet addresses found.");
    }

    if (duplicateTelegramIds.length > 0) {
      console.log("Duplicate Telegram IDs found:", duplicateTelegramIds);
    } else {
      console.log("No duplicate Telegram IDs found.");
    }

    console.log("Fetching and storing balances...");
    const balanceResult = await fetchAndStoreBalances(collection, provider);
    totalPopulation = balanceResult.totalPopulation;
    totalSityBalance = balanceResult.totalSityBalance;
    console.log(
      `Total Population: ${totalPopulation}, Total SITY Balance: ${totalSityBalance}`
    );

    console.log("All operations completed successfully. Preparing summary...");
    const summary = {
      refNumberGeneratedCount,
      walletIdUpdatedCount,
      nftFieldUpdatedCount,
      duplicateWalletAddresses,
      duplicateTelegramIds,
      totalPopulation,
      totalSityBalance,
    };

    console.log("Sending summary email...");
    await sendEmail(summary);
    console.log("Summary email sent successfully!");
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    console.log("Closing MongoDB connection...");
    await client.close();
    console.log("MongoDB connection closed. Script completed.");
  }
}

// If you run in Render cron jobs, just deploy this code in Render and set up a cron job command like:
// node update-nfts.js
// at the desired interval (e.g. daily at midnight).

main().catch(console.error);
