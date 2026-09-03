// Criterios centralizados de clasificacion de clientes para el CRM.
// Cambia estos numeros si el negocio quiere ajustar que cuenta como
// "frecuente", "VIP" o "inactivo".
const RULES = {
  vipMinCompleted: 6,
  vipMinSpent: 200000,
  frequentMinCount: 3,
  inactiveDays: 60,
};

function classifyClient({ totalCount, completedCount, totalSpent, lastVisitDate, hasUpcoming, today }) {
  if (completedCount >= RULES.vipMinCompleted || totalSpent >= RULES.vipMinSpent) return "vip";
  if (totalCount >= RULES.frequentMinCount) return "frecuente";
  if (!hasUpcoming && lastVisitDate) {
    const days = Math.floor((new Date(today) - new Date(lastVisitDate)) / 86400000);
    if (days > RULES.inactiveDays) return "inactivo";
  }
  if (totalCount <= 1) return "nuevo";
  return "regular";
}

module.exports = { RULES, classifyClient };
