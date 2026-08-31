export function computeUnreadTravelCount(
  travels: Array<{ id: string }>,
  lastSeenTravelId: string | null
) {
  if (!lastSeenTravelId) return travels.length;
  const index = travels.findIndex((travel) => travel.id === lastSeenTravelId);
  return index < 0 ? travels.length : index;
}
