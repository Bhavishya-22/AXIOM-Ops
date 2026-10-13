import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

async function main() {
    const users = [
        {
            id: "operator-1",
            name: "Operator One",
            role: "operator",
            tokenHash: hashToken(process.env.OPERATOR_1_TOKEN || "operator-1-token"),
        },
        {
            id: "operator-2",
            name: "Operator Two",
            role: "operator",
            tokenHash: hashToken(process.env.OPERATOR_2_TOKEN || "operator-2-token"),
        },
        {
            id: "sme-1",
            name: "Subject Matter Expert 1",
            role: "sme",
            tokenHash: hashToken(process.env.SME_1_TOKEN || "sme-1-token"),
        },
    ];

    for (const user of users) {
        await prisma.demoUser.upsert({
            where: { id: user.id },
            update: { tokenHash: user.tokenHash, role: user.role, name: user.name },
            create: user,
        });
    }

    console.log("Demo users seeded successfully.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });