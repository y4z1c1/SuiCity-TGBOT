import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import fs from "fs/promises";

dotenv.config();

// connect to mongodb
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

// count staked sitizen nfts by type
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
    sivilian: 0, // index 0
    general: 0, // index 1
    officer: 0, // index 2
    clown: 0, // index 3
    engineer: 0, // index 4
    legendary: 0, // index 5
  };

  const usersWithStaked = [];
  const nonSivilianUsers = [];
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

          // collect document if it has non-zero values in the stakedNfts array
          let hasStakedNfts = false;
          let hasNonSivilianNfts = false;

          if (Array.isArray(stakedNfts)) {
            // Define type names by index position
            const typeNames = [
              "sivilian",
              "general",
              "officer",
              "clown",
              "engineer",
              "legendary",
            ];

            // Process each staked NFT count by index position
            for (
              let i = 0;
              i < Math.min(stakedNfts.length, typeNames.length);
              i++
            ) {
              const count = parseInt(stakedNfts[i] || "0", 10);

              if (!isNaN(count) && count > 0) {
                // Add to the appropriate type counter based on index position
                types[typeNames[i]] += count;
                types.total += count;
                hasStakedNfts = true;

                // Check if this is a non-sivilian NFT type (index > 0)
                if (i > 0) {
                  hasNonSivilianNfts = true;
                }
              }
            }
          }

          if (hasStakedNfts) {
            usersWithStaked.push({
              walletAddress: doc.walletAddress,
              staked: stakedNfts,
            });

            // If wallet has non-sivilian NFTs, add to the special list
            if (hasNonSivilianNfts) {
              nonSivilianUsers.push({
                walletAddress: doc.walletAddress,
                staked: stakedNfts,
              });
            }
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
  console.log(
    `users with non-sivilian staked nfts: ${nonSivilianUsers.length}`
  );

  // Display detected NFT types
  console.log("\nDetected NFT types from data:");
  console.log(`sivilian (index 0): ${types.sivilian}`);
  console.log(`general (index 1): ${types.general}`);
  console.log(`officer (index 2): ${types.officer}`);
  console.log(`clown (index 3): ${types.clown}`);
  console.log(`engineer (index 4): ${types.engineer}`);
  console.log(`legendary (index 5): ${types.legendary}`);
  console.log(`total staked NFTs: ${types.total}`);

  // Save non-sivilian users to a JSON file
  try {
    const outputData = {
      summary: {
        totalUsersWithNonSivilianNfts: nonSivilianUsers.length,
        generalCount: types.general,
        officerCount: types.officer,
        clownCount: types.clown,
        engineerCount: types.engineer,
        legendaryCount: types.legendary,
      },
      users: nonSivilianUsers,
    };

    await fs.writeFile(
      "non_sivilian_stakers.json",
      JSON.stringify(outputData, null, 2)
    );

    console.log("Non-sivilian stakers data saved to non_sivilian_stakers.json");
  } catch (error) {
    console.error("Error saving non-sivilian users file:", error);
  }

  return { types, usersWithStaked, nonSivilianUsers };
}

async function main() {
  try {
    console.log("connecting to mongodb...");
    await client.connect();
    console.log("connected successfully");

    const database = client.db("twitter_bindings");
    const collection = database.collection("bindings");

    // count staked sitizens
    const { types, usersWithStaked } = await countStakedSitizens(collection);

    // display results in a formatted table
    console.log("\nstaked sitizen nft statistics:");
    console.log("-----------------------------");
    console.log(`total staked:   ${types.total}`);
    console.log(`sivilians:      ${types.sivilian}`);
    console.log(`generals:       ${types.general}`);
    console.log(`officers:       ${types.officer}`);
    console.log(`clowns:         ${types.clown}`);
    console.log(`engineers:      ${types.engineer}`);
    console.log(`legendary:      ${types.legendary}`);
    console.log("-----------------------------");
    console.log(`unique users:   ${usersWithStaked.length}`);
    console.log("-----------------------------");
  } catch (error) {
    console.error("error:", error);
  } finally {
    await client.close();
    console.log("mongodb connection closed");
  }
}

main().catch(console.error);
