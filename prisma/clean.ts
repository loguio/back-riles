import { PrismaClient, PlanType, AuthProvider } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log(
    "🧹 Vidage complet de la base de données Riles (PostgreSQL / Supabase)...",
  );

  // Nettoyage en cascade de toutes les tables dépendantes
  await prisma.webhookEvent.deleteMany({});
  const deletedCheckIns = await prisma.rpeCheckIn.deleteMany({});
  const deletedMessages = await prisma.chatMessage.deleteMany({});
  await prisma.quickPrompt.deleteMany({});
  const deletedTokens = await prisma.syncToken.deleteMany({});
  const deletedRules = await prisma.lifeRule.deleteMany({});
  const deletedWorkouts = await prisma.workout.deleteMany({});
  const deletedUsers = await prisma.user.deleteMany({});

  console.log(`🗑️  Éléments purgés :`);
  console.log(`   - Séances d'entraînement : ${deletedWorkouts.count}`);
  console.log(`   - Règles de vie : ${deletedRules.count}`);
  console.log(`   - Messages Coach chat : ${deletedMessages.count}`);
  console.log(
    `   - Jetons de synchronisation (Strava/Garmin) : ${deletedTokens.count}`,
  );
  console.log(`   - RPE Check-ins : ${deletedCheckIns.count}`);
  console.log(`   - Utilisateurs : ${deletedUsers.count}`);

  // Recréation de l'utilisateur par défaut dans un état 100% vierge, prêt pour l'onboarding
  const blankUser = await prisma.user.create({
    data: {
      id: "user-01",
      email: "marius@riles.app",
      name: "Marius",
      initials: "ML",
      readinessScore: 88,
      activeGoalTitle: "",
      activeGoalTarget: "",
      activeGoalRaceDate: "",
      activeGoalWeeksRemaining: 0,
      activeGoalProgressPercentage: 0,
      activeWeeks: 0,
      totalKm: 0,
      completedRaces: 0,
      planType: PlanType.PRO,
      authProvider: AuthProvider.APPLE,
      isOnboardingCompleted: false,
      mainGoal: null,
      selectedSports: ["running"],
    },
  });

  console.log("\n✅ Base de données réinitialisée à 100 % !");
  console.log(`👤 Utilisateur actif : ${blankUser.name} (${blankUser.email})`);
  console.log(`🚀 État : isOnboardingCompleted = false`);
  console.log(
    `👉 Tu peux maintenant ouvrir l'application et refaire le parcours d'onboarding complet de A à Z !`,
  );
}

main()
  .catch((e) => {
    console.error("❌ Erreur lors du nettoyage de la base :", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
