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

// Retry parameters
const MAX_RETRIES = 10;
const BACKOFF_TIME = 1500; // 3 seconds

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
        // Check if nft field is an object instead of string
        if (user.nft && typeof user.nft === "object") {
          console.log(
            `User ${user.walletAddress} has nft as object, will update to use object ID`
          );
          // Force a fetch to get current NFT data
          const fetchedNft = await fetchNftFromWalletCached(
            provider,
            user.walletAddress,
            nftCache
          );
          return { user, fetchedNft, forceUpdate: true };
        }

        // Original check for missing data
        if (
          user.nft &&
          user.walletId &&
          user.nftData &&
          typeof user.nft === "string"
        ) {
          console.log(
            `User ${user.walletAddress} already has valid NFT, walletId, and nftData, skipping blockchain call.`
          );
          return { user, fetchedNft: null, forceUpdate: false };
        }

        const fetchedNft = await fetchNftFromWalletCached(
          provider,
          user.walletAddress,
          nftCache
        );
        return { user, fetchedNft, forceUpdate: false };
      })
    )
  );

  const updates = [];
  let walletIdUpdatedCount = 0;
  let nftFieldUpdatedCount = 0;
  for (const { user, fetchedNft, forceUpdate } of results) {
    // Skip if no updates needed and not forcing update
    if (
      !fetchedNft &&
      user.nft &&
      user.walletId &&
      user.nftData &&
      !forceUpdate
    ) {
      console.log(
        `No changes needed for user ${user.walletAddress}. Already up-to-date.`
      );
      continue;
    }

    if (!fetchedNft) {
      // Here, we proved the user doesn't have the NFT (since we tried and didn't find it)
      // Remove user from the database
      console.log(
        `No NFT found for user ${user.walletAddress}, removing user from database.`
      );
      await collection.deleteOne({ _id: user._id });
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

    // Prepare the update document
    const updateDoc = { $set: {} };
    let needsUpdate = false;

    // Check if walletId needs update
    if (user.walletId !== walletObjectId) {
      updateDoc.$set.walletId = walletObjectId;
      updateDoc.$set.nftName = nftName;
      walletIdUpdatedCount++;
      needsUpdate = true;
    }

    // Check if NFT needs update or is in wrong format
    if (
      !user.nft ||
      user.nft !== fetchedNftId ||
      typeof user.nft === "object"
    ) {
      updateDoc.$set.nft = fetchedNftId;
      updateDoc.$set.nftName = nftName;
      nftFieldUpdatedCount++;
      needsUpdate = true;
    }

    // Always update nftData if we fetched new NFT data or forcing update
    if (!user.nftData || needsUpdate || forceUpdate) {
      updateDoc.$set.nftData = fetchedNft;
      needsUpdate = true;
      console.log(`Updating nftData for user ${user.walletAddress}`);
    }

    if (needsUpdate) {
      updates.push({
        updateOne: {
          filter: { _id: user._id },
          update: updateDoc,
        },
      });
    }
  }

  if (updates.length > 0) {
    console.log(
      `Performing bulk write for ${updates.length} NFT/wallet/nftData updates...`
    );
    await collection.bulkWrite(updates);
    console.log("Bulk NFT/wallet/nftData updates completed.");
  } else {
    console.log("No NFT/wallet/nftData updates needed.");
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

// Function to count staked Sitizen NFTs by type
async function countStakedSitizens(collection) {
  console.log("counting staked sitizen nfts by type...");

  // get all documents that have nftData
  const cursor = collection
    .find({
      "nftData.content.fields": { $exists: true },
    })
    .project({
      walletAddress: 1,
      "nftData.content.fields.extra_nested_data": 1,
    });

  // initialize counters
  const types = {
    total: 0,
    sivilian: 0, // index 0 - renamed to be consistent with email template
    general: 0, // index 1
    officer: 0, // index 2
    clown: 0, // index 3
    engineer: 0, // index 4
    legendary: 0, // index 5
  };

  const usersWithStaked = [];
  let totalScanned = 0;
  let docsWithExtraNestedLength2 = 0;

  // manually process each document
  await cursor.forEach((doc) => {
    totalScanned++;

    if (totalScanned % 1000 === 0) {
      console.log(`scanned ${totalScanned} documents...`);
    }

    try {
      // check if doc has extra_nested_data
      if (doc.nftData?.content?.fields?.extra_nested_data) {
        const extraNestedData = doc.nftData.content.fields.extra_nested_data;

        // check if extra_nested_data has length of 2 (from example, this is how they're structured)
        if (Array.isArray(extraNestedData) && extraNestedData.length === 2) {
          docsWithExtraNestedLength2++;
          const stakedNfts = extraNestedData[1];

          // collect document if it has any staked NFTs
          let hasStakedNfts = false;

          if (Array.isArray(stakedNfts)) {
            for (let i = 0; i < stakedNfts.length; i++) {
              const nftType = stakedNfts[i];

              // FIXED: Count all entries, including "0" which represents civilians
              types.total++;
              hasStakedNfts = true;

              // Handle each NFT type as a string
              if (nftType === "0") {
                types.sivilian++;
              } else if (nftType === "1") {
                types.general++;
              } else if (nftType === "2") {
                types.officer++;
              } else if (nftType === "3") {
                types.clown++;
              } else if (nftType === "4") {
                types.engineer++;
              } else if (nftType === "5") {
                types.legendary++;
              } else {
                console.log(`unknown nft type: ${nftType}`);
              }
            }
          }

          if (hasStakedNfts) {
            usersWithStaked.push({
              walletAddress: doc.walletAddress,
              staked: stakedNfts,
            });
          }
        }
      }
    } catch (error) {
      console.error("error processing document:", error);
    }
  });

  console.log(`\ntotal documents scanned: ${totalScanned}`);
  console.log(
    `documents with extra_nested_data of length 2: ${docsWithExtraNestedLength2}`
  );
  console.log(`users with at least one staked nft: ${usersWithStaked.length}`);
  console.log(`total staked sitizens: ${types.total}`);
  console.log(`staked civilians: ${types.sivilian}`);
  console.log(`staked generals: ${types.general}`);
  console.log(`staked officers: ${types.officer}`);
  console.log(`staked clowns: ${types.clown}`);
  console.log(`staked engineers: ${types.engineer}`);
  console.log(`staked legendaries: ${types.legendary}`);
  console.log(
    `sivilians: ${types.sivilian}, generals: ${types.general}, officers: ${types.officer}`
  );

  return types;
}

function formatBalance(balance) {
  if (balance >= 1e12) return (balance / 1e12).toFixed(2) + "t";
  if (balance >= 1e9) return (balance / 1e9).toFixed(2) + "b";
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
    totalPopulation: formatBalance(totalPopulation),
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

async function sendEmail(summary, runTime) {
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

Staked Sitizen NFTs:
- Total Staked: ${summary.stakedSitizens.total}
- Sivilians: ${summary.stakedSitizens.sivilian}
- Generals: ${summary.stakedSitizens.general}
- Officers: ${summary.stakedSitizens.officer}
- Clowns: ${summary.stakedSitizens.clown}
- Engineers: ${summary.stakedSitizens.engineer}
- Legendary: ${summary.stakedSitizens.legendary}

Duplicate Wallet Addresses: ${
    summary.duplicateWalletAddresses.join(", ") || "None"
  }
Duplicate Telegram IDs: ${summary.duplicateTelegramIds.join(", ") || "None"}

Script Run Time: ${runTime.minutes} minutes and ${runTime.seconds} seconds

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
  const startTime = Date.now();

  let refNumberGeneratedCount = 0;
  let walletIdUpdatedCount = 0;
  let nftFieldUpdatedCount = 0;
  let duplicateWalletAddresses = [];
  let duplicateTelegramIds = [];
  let totalPopulation = 0;
  let totalSityBalance = "";
  let stakedSitizens = {
    total: 0,
    sivilian: 0,
    general: 0,
    officer: 0,
    clown: 0,
    engineer: 0,
    legendary: 0,
  };

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

    console.log("Counting staked Sitizen NFTs...");
    stakedSitizens = await countStakedSitizens(collection);
    console.log(`Total staked Sitizens: ${stakedSitizens.total}`);

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
      stakedSitizens,
    };

    const endTime = Date.now();
    const elapsedTimeMs = endTime - startTime;
    const runMinutes = Math.floor(elapsedTimeMs / 60000);
    const runSeconds = ((elapsedTimeMs % 60000) / 1000).toFixed(0);

    console.log("Sending summary email...");
    await sendEmail(summary, { minutes: runMinutes, seconds: runSeconds });
    console.log("Summary email sent successfully!");
  } catch (error) {
    console.error("Error in main execution:", error);
  } finally {
    console.log("Closing MongoDB connection...");
    await client.close();
    console.log("MongoDB connection closed. Script completed.");
  }
}

// Run as needed or set up as a cron job in Render

main().catch(console.error);
