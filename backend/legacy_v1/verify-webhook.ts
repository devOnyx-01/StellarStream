import { WebhookService } from "./services/webhook.service.js";

async function verifyWebhookLogic() {
    console.log("--- Webhook Logic Verification ---");

    void new WebhookService();

    // Mock Large Stream (> 10,000 XLM)
    const largeStream = {
        eventType: "stream_created",
        streamId: "123",
        txHash: "0xabc",
        sender: "G...SENDER",
        receiver: "G...RECEIVER",
        amount: "100000000001", // > 10,000 XLM (7 decimals)
        timestamp: new Date().toISOString(),
    };

    const XLM_THRESHOLD = 10000_0000000n;
    const isLarge = BigInt(largeStream.amount) >= XLM_THRESHOLD;

    console.log(`Testing Large Stream: Amount=${largeStream.amount}, Threshold=${XLM_THRESHOLD}`);
    console.log(`Condition (amount >= threshold): ${isLarge}`);

    if (isLarge) {
        console.log("Logic: Webhook WOULD be triggered.");
    } else {
        console.log("Logic: Webhook WOULD NOT be triggered.");
    }

    // Mock Small Stream (< 10,000 XLM)
    const smallStream = {
        amount: "50000000000", // 5,000 XLM
    };
    const isSmallLarge = BigInt(smallStream.amount) >= XLM_THRESHOLD;
    console.log(`Testing Small Stream: Amount=${smallStream.amount}`);
    console.log(`Condition (amount >= threshold): ${isSmallLarge}`);
}

verifyWebhookLogic().catch(console.error);
