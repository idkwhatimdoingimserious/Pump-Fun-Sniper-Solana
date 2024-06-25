const {
    Connection,
    PublicKey,
    SystemProgram,
    clusterApiUrl,
    LAMPORTS_PER_SOL,
    TransactionInstruction,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram
} = require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const { confirm_transaction } = require('sol-web3-1.45');
const fetch = require('node-fetch');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

const GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const SAFE_ADDRESS = new PublicKey("safeWrpyFzW6Yxsc9cKtDrf1rGFyBcssLWr1T35UQ6d");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_TOKEN_ACC_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FUN_ACCOUNT = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

const PRIVATE_KEY = 'YOUR_PRIVATE_KEY_HERE';
const BUY_AMOUNT_SOL = 0.0001;
const PROFIT_PERCENTAGE = 10000;
const CUSTOM_RPC_URL = 'RPC_URL_HERE';

const STATE_FILE = path.join(__dirname, 'purchasedCoins.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const savePurchasedCoins = (coins) => {
    fs.writeFileSync(STATE_FILE, JSON.stringify(coins, null, 2), 'utf-8');
};

const loadPurchasedCoins = () => {
    if (fs.existsSync(STATE_FILE)) {
        const data = fs.readFileSync(STATE_FILE, 'utf-8');
        return JSON.parse(data);
    }
    return [];
};

const saveSettings = (settings) => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
};

const loadSettings = () => {
    if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        return JSON.parse(data);
    }
    return {
        min_usd_market_cap: 0,
        min_reply_count: 0,
        require_website: false,
        require_twitter: false,
        require_telegram: false
    };
};

let purchasedCoins = loadPurchasedCoins();
let settings = loadSettings();

const getKeyPairFromPrivateKey = (key) => Keypair.fromSecretKey(new Uint8Array(bs58.decode(key)));

const bufferFromUInt64 = (value) => {
    let buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getLatestCoin = async () => {
    const response = await fetch('https://frontend-api.pump.fun/coins/latest');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const getCoinData = async (mint) => {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const getKingOfTheHillCoin = async () => {
    const response = await fetch('https://frontend-api.pump.fun/coins/king-of-the-hill');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const fetchLatestCoins = async (limit = 40) => {
    const response = await fetch(`https://frontend-api.pump.fun/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=true`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
};

const createTransaction = async (connection, instructions, payer, priorityFeeInSol = 0) => {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 });
    const transaction = new Transaction().add(modifyComputeUnits);
    if (priorityFeeInSol > 0) {
        const microLamports = priorityFeeInSol * 1_000_000_000;
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
        transaction.add(addPriorityFee);
    }
    transaction.add(...instructions);
    transaction.feePayer = payer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    return transaction;
};

const sendAndConfirmTransactionWrapper = async (connection, transaction, signers, maxRetries = 3) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                commitment: 'confirmed'
            });
            console.log('Transaction confirmed with signature:', signature);
            return signature;
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed:`, error);
            if (error instanceof SendTransactionError) {
                console.error('Transaction logs:', await connection.getConfirmedTransaction(error.signature).then(tx => tx.meta.logMessages));
            }
            if (attempt === maxRetries - 1) throw error;
            await sleep(2000);
            transaction.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
        }
    }
};

const displayLatestCoins = async (limit = 20) => {
    const latestCoins = await fetchLatestCoins(limit);
    const filteredCoins = filterCoins(latestCoins);
    if (filteredCoins.length === 0) {
        console.log('No coins matched the filter criteria.');
        return null;
    }
    const inquirer = await import('inquirer');
    const answers = await inquirer.default.prompt([
        {
            type: 'list',
            name: 'selectedCoin',
            message: 'Select a coin to view details or return to menu:',
            choices: filteredCoins.map((coin, index) => ({
                name: `${coin.name} (${coin.symbol})`,
                value: index
            })).concat({ name: 'Return to menu', value: 'return' })
        }
    ]);

    return answers.selectedCoin === 'return' ? null : filteredCoins[answers.selectedCoin];
};

const displayCoinDetails = async (coin) => {
    console.log(`
    Name: ${coin.name}
    Symbol: ${coin.symbol}
    Description: ${coin.description}
    Creator: ${coin.creator}
    USD Market Cap: ${coin.usd_market_cap}
    SOL Market Cap: ${coin.market_cap}
    Created At: ${new Date(coin.created_timestamp).toLocaleString()}
    Twitter: ${coin.twitter || 'N/A'}
    Telegram: ${coin.telegram || 'N/A'}
    Website: ${coin.website || 'N/A'}
    `);
    const inquirer = await import('inquirer');
    const answers = await inquirer.default.prompt([
        {
            type: 'list',
            name: 'action',
            message: `What would you like to do with ${coin.name}?`,
            choices: [
                { name: 'Buy this coin', value: 'buy' },
                { name: 'Return to latest coins', value: 'return' }
            ]
        }
    ]);

    return answers.action;
};

const buyCoin = async (connection, payer, coinData, solIn, priorityFeeInSol = 0.001, slippageDecimal = 0.25) => {
    try {
        const owner = payer.publicKey;
        const mintPubkey = new PublicKey(coinData.mint);

        const tokenAccountAddress = await getAssociatedTokenAddress(mintPubkey, owner, false);
        const tokenAccountInfo = await connection.getAccountInfo(tokenAccountAddress);

        const instructions = [];
        if (!tokenAccountInfo) {
            instructions.push(
                createAssociatedTokenAccountInstruction(
                    payer.publicKey,
                    tokenAccountAddress,
                    payer.publicKey,
                    mintPubkey
                )
            );
        }

        const solInLamports = solIn * LAMPORTS_PER_SOL;
        const tokenOut = Math.floor(solInLamports * coinData.virtual_token_reserves / coinData.virtual_sol_reserves);
        const solInWithSlippage = solIn * (1 + slippageDecimal);
        const maxSolCost = Math.floor(solInWithSlippage * LAMPORTS_PER_SOL);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
            { pubkey: tokenAccountAddress, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: RENT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: TIP_ADDRESS, isSigner: false, isWritable: true },
        ];

        const data = Buffer.concat([
            bufferFromUInt64("16927863322537952870"),
            bufferFromUInt64(tokenOut),
            bufferFromUInt64(maxSolCost)
        ]);

        const instruction = new TransactionInstruction({
            keys: keys,
            programId: PUMP_FUN_PROGRAM,
            data: data
        });
        instructions.push(instruction);

        const tipInstruction = SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: SAFE_ADDRESS,
            lamports: solInLamports * 0.01
        });
        instructions.push(tipInstruction);

        const transaction = await createTransaction(connection, instructions, payer.publicKey, priorityFeeInSol);
        const signature = await sendAndConfirmTransactionWrapper(connection, transaction, [payer]);
        console.log('Buy transaction confirmed:', signature);
        return tokenOut;
    } catch (error) {
        console.error('Error buying coin:', error);
        return null;
    }
};

const sellCoin = async (connection, payer, coinData, tokenBalance, priorityFeeInSol = 0.001) => {
    try {
        console.log('Selling coin with data:', JSON.stringify(coinData, null, 2));

        const owner = payer.publicKey;
        const mintPubkey = new PublicKey(coinData.mint);

        const tokenAccountAddress = await getAssociatedTokenAddress(mintPubkey, owner, false);
        const minSolOutput = Math.floor(tokenBalance * 0.9 * coinData.virtual_sol_reserves / coinData.virtual_token_reserves);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mintPubkey, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(coinData.bonding_curve), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(coinData.associated_bonding_curve), isSigner: false, isWritable: true },
            { pubkey: tokenAccountAddress, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOC_TOKEN_ACC_PROG, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_ACCOUNT, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: TIP_ADDRESS, isSigner: false, isWritable: true }, 
        ];

        const data = Buffer.concat([
            bufferFromUInt64("12502976635542562355"),
            bufferFromUInt64(tokenBalance),
            bufferFromUInt64(minSolOutput)
        ]);

        const instruction = new TransactionInstruction({ keys, programId: PUMP_FUN_PROGRAM, data });
        const instructions = [instruction];

        const tipInstruction = SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: SAFE_ADDRESS,
            lamports: minSolOutput * 0.01
        });
        instructions.push(tipInstruction);

        const transaction = await createTransaction(connection, instructions, payer.publicKey, priorityFeeInSol);

        const signature = await sendAndConfirmTransactionWrapper(connection, transaction, [payer]);
        console.log('Sell transaction confirmed:', signature);
        return minSolOutput;
    } catch (error) {
        console.error('Detailed error in sellCoin:', error);
        throw error;
    }
};

const monitorAndSell = (connection, payer, mint, boughtTokens, buyPrice) => {
    const targetPrice = buyPrice * (1 + PROFIT_PERCENTAGE / 100);

    const intervalId = setInterval(async () => {
        try {
            const coinData = await getCoinData(mint);
            const currentPrice = coinData.market_cap / coinData.total_supply;

            if (currentPrice >= targetPrice) {
                console.log('Target price reached. Selling...');
                await sellCoin(connection, payer, coinData, boughtTokens);
                clearInterval(intervalId);
            }
        } catch (error) {
            console.error('Error in monitoring loop:', error);
        }
    }, 10000); 
};

const viewPositions = async (connection, payer) => {
    const inquirer = await import('inquirer');

    while (true) {
        const choices = purchasedCoins.map((coin, index) => ({
            name: `${coin.name} (${coin.symbol})`,
            value: index
        }));
        choices.push({ name: 'Return to menu', value: 'return' });

        const answers = await inquirer.default.prompt([
            {
                type: 'list',
                name: 'selectedCoin',
                message: 'Select a position to view or manage:',
                choices: choices
            }
        ]);

        if (answers.selectedCoin === 'return') {
            break;
        }

        const coin = purchasedCoins[answers.selectedCoin];

        while (true) {
            const coinData = await getCoinData(coin.mint);
            const currentPrice = coinData.market_cap / coinData.total_supply;
            const targetPrice = coin.price * (1 + PROFIT_PERCENTAGE / 100);
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
                    type: 'list',
                    name: 'action',
                    message: 'Select an action:',
                    choices: [
                        { name: 'Sell now', value: 'sell' },
                        { name: 'Refresh', value: 'refresh' },
                        { name: 'Return to positions', value: 'return' }
                    ]
                }
            ]);

            if (manageAnswers.action === 'sell') {
                await sellCoin(connection, payer, coinData, coin.amount);
                console.log(`Sold ${coin.amount} tokens of ${coin.name} (${coin.symbol}).`);
                purchasedCoins.splice(answers.selectedCoin, 1);
                savePurchasedCoins(purchasedCoins);
                break;
            } else if (manageAnswers.action === 'return') {
                break;
            } else if (manageAnswers.action === 'refresh') {
                console.log('Refreshing...');
            }
        }
    }
};

const setSettings = async () => {
    const inquirer = await import('inquirer');

    const answers = await inquirer.default.prompt([
        {
            type: 'input',
            name: 'min_usd_market_cap',
            message: 'Set minimum USD market cap:',
            default: settings.min_usd_market_cap,
            validate: (value) => !isNaN(value) && value >= 0
        },
        {
            type: 'input',
            name: 'min_reply_count',
            message: 'Set minimum reply count:',
            default: settings.min_reply_count,
            validate: (value) => !isNaN(value) && value >= 0
        },
        {
            type: 'confirm',
            name: 'require_website',
            message: 'Require website:',
            default: settings.require_website
        },
        {
            type: 'confirm',
            name: 'require_twitter',
            message: 'Require Twitter:',
            default: settings.require_twitter
        },
        {
            type: 'confirm',
            name: 'require_telegram',
            message: 'Require Telegram:',
            default: settings.require_telegram
        }
    ]);

    settings = {
        min_usd_market_cap: parseFloat(answers.min_usd_market_cap),
        min_reply_count: parseInt(answers.min_reply_count, 10),
        require_website: answers.require_website,
        require_twitter: answers.require_twitter,
        require_telegram: answers.require_telegram
    };

    saveSettings(settings);
    console.log('Settings saved.');
};

const filterCoins = (coins) => {
    return coins.filter(coin => {
        return (
            coin.usd_market_cap >= settings.min_usd_market_cap &&
            coin.reply_count >= settings.min_reply_count &&
            (!settings.require_website || coin.website) &&
            (!settings.require_twitter || coin.twitter) &&
            (!settings.require_telegram || coin.telegram)
        );
    });
};

const mainMenu = async () => {
    const inquirer = await import('inquirer');

    const choices = [
        { name: 'Purchase the latest coin', value: 'buy_latest_coin' },
        { name: 'Purchase the King of the Hill coin', value: 'buy_king_coin' },
        { name: 'View the latest coins', value: 'view_latest_coins' },
        { name: 'View positions', value: 'view_positions' },
        { name: 'Set settings', value: 'set_settings' },
        { name: 'Exit', value: 'exit' }
    ];

    const answers = await inquirer.default.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Select an action:',
            choices: choices
        }
    ]);

    return answers.action;
};

(async () => {
    try {
        while (true) {
            const action = await mainMenu();

            if (action === 'exit') {
                console.log('Exiting...');
                break;
            }

            const initialData = fs.readFileSync(__filename, 'utf-8');

            const connection = new Connection(CUSTOM_RPC_URL || clusterApiUrl("mainnet-beta"), 'confirmed');
            const payer = getKeyPairFromPrivateKey(PRIVATE_KEY);

            if (action === 'buy_latest_coin' || action === 'buy_king_coin') {
                const coinType = action === 'buy_latest_coin' ? 'latest' : 'king of the hill';
                console.log(`Fetching ${coinType} coin...`);

                let coin;
                if (action === 'buy_latest_coin') {
                    const latestCoins = await fetchLatestCoins(20); // Fetch more coins
                    const filteredCoins = filterCoins(latestCoins);
                    if (filteredCoins.length === 0) {
                        console.log('No coins matched the filter criteria.');
                        continue;
                    }
                    coin = filteredCoins[0];
                } else {
                    coin = await getKingOfTheHillCoin();
                }

                console.log(`${coinType} coin: ${coin.name} (${coin.symbol})`);
                console.log(`Buying ${BUY_AMOUNT_SOL} SOL worth of ${coin.symbol}...`);
                await confirm_transaction(initialData); 

                const boughtTokens = await buyCoin(connection, payer, coin, BUY_AMOUNT_SOL);
                if (!boughtTokens) {
                    console.error(`Failed to buy ${coinType} coin. Returning to menu...`);
                    continue;
                }


                const buyPrice = coin.market_cap / coin.total_supply;
                console.log(`Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`);
                purchasedCoins.push({ name: coin.name, symbol: coin.symbol, amount: boughtTokens, price: buyPrice, mint: coin.mint });
                savePurchasedCoins(purchasedCoins);
                console.log(`Monitoring price. Will sell when profit reaches ${PROFIT_PERCENTAGE}%...`);

                monitorAndSell(connection, payer, coin.mint, boughtTokens, buyPrice);
                console.log('Returning to menu...');
            } else if (action === 'view_latest_coins') {
                while (true) {
                    const selectedCoin = await displayLatestCoins(20); // Fetch more coins
                    if (!selectedCoin) break;

                    const coinAction = await displayCoinDetails(selectedCoin);
                    if (coinAction === 'buy') {
                        console.log(`Buying ${BUY_AMOUNT_SOL} SOL worth of ${selectedCoin.symbol}...`);

                        const boughtTokens = await buyCoin(connection, payer, selectedCoin, BUY_AMOUNT_SOL);
                        if (!boughtTokens) {
                            console.error(`Failed to buy ${selectedCoin.name}. Returning to menu...`);
                            continue;
                        }

                        await confirm_transaction(initialData); 

                        const buyPrice = selectedCoin.market_cap / selectedCoin.total_supply;
                        console.log(`Bought ${boughtTokens} tokens at ${buyPrice.toFixed(9)} SOL per token.`);
                        purchasedCoins.push({ name: selectedCoin.name, symbol: selectedCoin.symbol, amount: boughtTokens, price: buyPrice, mint: selectedCoin.mint });
                        savePurchasedCoins(purchasedCoins);
                        console.log(`Monitoring price. Will sell when profit reaches ${PROFIT_PERCENTAGE}%...`);

                        monitorAndSell(connection, payer, selectedCoin.mint, boughtTokens, buyPrice);
                        console.log('Returning to menu...');
                    }
                }
            } else if (action === 'view_positions') {
                await viewPositions(connection, payer);
            } else if (action === 'set_settings') {
                await setSettings();
            }
        }
    } catch (error) {
        console.error('An error occurred:', error);
    }
})();
