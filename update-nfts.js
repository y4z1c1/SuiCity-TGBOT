import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import fs from "fs";

dotenv.config();

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let refNumberGeneratedCount = 0;
let walletIdUpdatedCount = 0;
let nftFieldUpdatedCount = 0;

const provider = new SuiClient({
  url: getFullnodeUrl("mainnet"),
});

const ADDRESSES = {
  NFT_TYPE:
    "0x5b9b4cd82aee3d5a942eebe9c2da38f411d82bfdfea1204f2486e45b5868b44f::nft::City",
};

const generateUniqueRefNumber = async (collection) => {
  let refNumber;
  let isUnique = false;
  let lowerBound = 20000;
  let upperBound = 100000;
  let attemptCount = 0;
  const maxAttempts = 100;

  while (!isUnique) {
    refNumber =
      Math.floor(Math.random() * (upperBound - lowerBound + 1)) + lowerBound;

    const existingRef = await collection.findOne({ refNumber });
    if (!existingRef) {
      isUnique = true;
    } else {
      attemptCount++;
    }

    if (attemptCount >= maxAttempts) {
      upperBound += 100000;
      attemptCount = 0;
    }
  }

  return refNumber;
};

// Fetch NFTs from the user's wallet
const fetchNftFromWallet = async (walletAddress) => {
  const allObjects = [];
  let lastObject = null;
  let hasMore = true;

  while (hasMore) {
    const object = await provider.getOwnedObjects({
      owner: String(walletAddress),
      cursor:
        lastObject?.data?.[lastObject.data.length - 1]?.data?.objectId || null,
      options: { showType: true },
    });

    allObjects.push(...object.data);

    if (object.data.length === 0 || !object.nextCursor) {
      hasMore = false;
    } else {
      lastObject = object;
    }
  }

  const nftObject = allObjects.find(
    (nft) => String(nft.data?.type) === `${ADDRESSES.NFT_TYPE}`
  );

  if (!nftObject) {
    return null;
  }

  const nftData = await provider.getObject({
    id: nftObject.data.objectId,
    options: { showContent: true, showType: true },
  });

  return nftData;
};

// Update NFT fields, generate refNumber, and update wallet ID
const updateNftField = async () => {
  let refNumberGeneratedCount = 0;
  let walletIdUpdatedCount = 0;
  let nftFieldUpdatedCount = 0;

  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    const database = client.db("twitter_bindings");
    const collection = database.collection("bindings");

    console.log("Backing up the current 'bindings' collection...");
    await database
      .collection("bindings")
      .aggregate([{ $match: {} }, { $out: "bindings_backup" }])
      .toArray();
    console.log("Backup completed.");

    console.log("Fetching all documents...");
    const users = await collection.find().toArray();

    // Duplicate checking
    const walletAddressCount = {};
    const telegramIdCount = {};

    for (const user of users) {
      const walletAddress = user.walletAddress;
      const telegramId = user.telegramId;

      // Count wallet addresses
      if (walletAddress) {
        walletAddressCount[walletAddress] =
          (walletAddressCount[walletAddress] || 0) + 1;
      }

      // Count telegram ids
      if (telegramId) {
        telegramIdCount[telegramId] = (telegramIdCount[telegramId] || 0) + 1;
      }
    }

    // Process each user for NFT and refNumber updates
    for (const user of users) {
      try {
        const walletAddress = user.walletAddress;
        const currentRefNumber = user.refNumber;
        const nftField = user.nft;

        if (!currentRefNumber) {
          console.log(
            `Generating a new reference number for user ${walletAddress}`
          );
          const newRefNumber = await generateUniqueRefNumber(collection);
          refNumberGeneratedCount++;

          console.log(
            `Assigning reference number ${newRefNumber} to user ${walletAddress}`
          );
          await collection.updateOne(
            { _id: user._id },
            { $set: { refNumber: newRefNumber } }
          );
        }

        console.log(`Fetching NFTs for user: ${walletAddress}`);
        const fetchedNft = await fetchNftFromWallet(walletAddress);

        if (!fetchedNft) {
          console.log(`No NFTs found for user ${walletAddress}`);
          continue;
        }

        const fetchedNftId = fetchedNft?.data?.objectId;
        const nftName =
          fetchedNft?.data?.content?.fields?.name || "Unnamed NFT";
        const walletObjectId = fetchedNft?.data?.content?.fields?.wallet;

        if (!walletObjectId) {
          console.log(`No wallet field found in NFT for user ${walletAddress}`);
          continue;
        }

        console.log(
          `Updating wallet ID and NFT name for user ${walletAddress} with wallet ID: ${walletObjectId}, NFT name: ${nftName}`
        );
        await collection.updateOne(
          { _id: user._id },
          { $set: { walletId: walletObjectId, nftName: nftName } }
        );
        walletIdUpdatedCount++;

        if (!nftField || nftField !== fetchedNftId) {
          console.log(
            `Updating NFT field for user ${walletAddress} with NFT ID: ${fetchedNftId}`
          );
          await collection.updateOne(
            { _id: user._id },
            { $set: { nft: fetchedNftId } }
          );
          nftFieldUpdatedCount++;
        }
      } catch (error) {
        console.error(`Error processing user ${user.walletAddress}:`, error);
      }
    }

    console.log("NFT validation and wallet ID update process completed.");

    // Check duplicates
    const duplicateWalletAddresses = Object.entries(walletAddressCount)
      .filter(([_, count]) => count > 1)
      .map(([address]) => address);

    const duplicateTelegramIds = Object.entries(telegramIdCount)
      .filter(([_, count]) => count > 1)
      .map(([id]) => id);

    console.log(`
      Summary Report:
      - Reference Numbers Generated: ${refNumberGeneratedCount}
      - Wallet IDs Updated: ${walletIdUpdatedCount}
      - NFT Fields Updated: ${nftFieldUpdatedCount}
    `);

    console.log("Duplicates:");
    if (duplicateWalletAddresses.length > 0) {
      console.log("Duplicate Wallet Addresses:");
      console.log(duplicateWalletAddresses);
    } else {
      console.log("No duplicate wallet addresses found.");
    }

    if (duplicateTelegramIds.length > 0) {
      console.log("Duplicate Telegram IDs:");
      console.log(duplicateTelegramIds);
    } else {
      console.log("No duplicate Telegram IDs found.");
    }

    return {
      success: true,
      message: "NFT fields, wallet IDs, and NFT names validated and updated.",
      summary: {
        refNumbersGenerated: refNumberGeneratedCount,
        walletIdsUpdated: walletIdUpdatedCount,
        nftFieldsUpdated: nftFieldUpdatedCount,
      },
    };
  } catch (error) {
    console.error("Error occurred during execution:", error);
    return {
      success: false,
      error:
        "Failed to validate and update NFT fields, wallet IDs, and NFT names.",
    };
  } finally {
    console.log("Closing MongoDB connection.");
    await client.close();
  }
};

// =======================================
// Balances fetching and storing functions (from get-balances.js)
// =======================================

const clientBalances = new MongoClient(uri); // separate client for balances

// Format large numbers into 'k' and 'm'
const formatBalance = (balance) => {
  if (balance >= 1e6) {
    return (balance / 1e6).toFixed(2) + "m";
  } else if (balance >= 1e3) {
    return (balance / 1e3).toFixed(2) + "k";
  } else {
    return balance.toFixed(2);
  }
};

const fetchSityBalance = async (walletId) => {
  try {
    const walletObject = await provider.getObject({
      id: walletId,
      options: { showContent: true },
    });

    const sityBalance = walletObject?.data?.content?.fields?.balance || 0;
    return sityBalance / 1e3;
  } catch (error) {
    console.error(
      `Error fetching SITY balance for walletId: ${walletId}`,
      error
    );
    return 0;
  }
};

const fetchAndStoreBalances = async () => {
  try {
    console.log("Connecting to MongoDB for balances...");
    await clientBalances.connect();
    const database = clientBalances.db("twitter_bindings");
    const collection = database.collection("bindings");

    console.log("Fetching all user walletIds and population data...");
    const users = await collection.find().toArray();

    const userBalances = [];
    let totalBalance = 0;
    let totalPopulation = 0;

    for (const user of users) {
      const walletId = user.walletId;
      const twitterId = user.twitterId;
      const population = user.population || 0;

      if (!walletId) {
        console.log(`User ${user.walletAddress} does not have a walletId.`);
        continue;
      }

      console.log(`Fetching SITY balance for walletId: ${walletId}`);
      const sityBalance = await fetchSityBalance(walletId);
      totalBalance += sityBalance;
      totalPopulation += population;

      userBalances.push({
        twitterId: twitterId,
        walletAddress: user.walletAddress,
        sityBalance: sityBalance,
        population: population,
      });
    }

    const formattedUserBalances = userBalances.map((user) => {
      const percentageHolding =
        totalBalance > 0 ? (user.sityBalance / totalBalance) * 100 : 0;

      return {
        twitterId: user.twitterId,
        walletAddress: user.walletAddress,
        sityBalance: formatBalance(user.sityBalance),
        population: user.population,
        percentageHolding: percentageHolding.toFixed(2) + "%",
      };
    });

    // Sort balances by sityBalance descending
    const sortedBalances = formattedUserBalances.sort((a, b) => {
      // Convert formatted sityBalance back to number for sorting
      const parseBalance = (val) => {
        const num = parseFloat(val.replace(/k|m/g, ""));
        if (val.includes("m")) return num * 1e6;
        if (val.includes("k")) return num * 1e3;
        return num;
      };

      return parseBalance(b.sityBalance) - parseBalance(a.sityBalance);
    });

    const output = {
      totalPopulation: totalPopulation,
      totalSityBalance: formatBalance(totalBalance),
      userBalances: sortedBalances,
    };

    fs.writeFileSync("balances.json", JSON.stringify(output, null, 2), "utf8");
    console.log(
      "Saved balances (sorted) with Twitter IDs, percentages, and population data to balances.json."
    );

    return output;
  } catch (error) {
    console.error("Error occurred during fetching/storing balances:", error);
    return {
      success: false,
      error: "Failed to fetch and store balances.",
    };
  } finally {
    console.log("Closing MongoDB connection for balances.");
    await clientBalances.close();
  }
};

// =======================================
// Sorting balances logic
// =======================================
const formatValue = (value) => {
  if (value >= 1e6) {
    return (value / 1e6).toFixed(2) + "m";
  } else if (value >= 1e3) {
    return (value / 1e3).toFixed(2) + "k";
  } else {
    return value.toFixed(2);
  }
};

const sortBalancesFile = () => {
  try {
    const data = fs.readFileSync("balances.json", "utf8");
    const balancesData = JSON.parse(data);

    const userBalances = balancesData.userBalances;

    const sortedUserBalances = userBalances.sort((a, b) => {
      const convert = (val) => {
        const num = parseFloat(val.replace(/k|m/g, ""));
        if (val.includes("m")) return num * 1e6;
        if (val.includes("k")) return num * 1e3;
        return num;
      };
      return convert(b.sityBalance) - convert(a.sityBalance);
    });

    const formattedUserBalances = sortedUserBalances.map((user) => ({
      twitterId: user.twitterId,
      walletAddress: user.walletAddress,
      sityBalance: user.sityBalance,
      population: formatValue(parseFloat(user.population)),
      percentageHolding: user.percentageHolding,
    }));

    fs.writeFileSync(
      "sorted_balances.json",
      JSON.stringify(formattedUserBalances, null, 2),
      "utf8"
    );

    console.log("Balances sorted and saved to sorted_balances.json.");
  } catch (error) {
    console.error("Error sorting balances:", error);
  }
};

// Execute the NFT field validation and update, then fetch balances and sort
updateNftField()
  .then(async (result) => {
    console.log("NFT Update Result:", result);

    // Now fetch and store balances
    await fetchAndStoreBalances();

    // Now sort balances
    sortBalancesFile();
  })
  .catch((err) => {
    console.error("Error in execution:", err);
  });
