export const USER_PAGE_SIZE = 24;
export const userStatuses = {
  active: 'Active',
  disabled: 'Disabled',
  deleted: 'Deleted',
};
export const userRoles = { user: 'User', admin: 'Administrator' };
export const userSortOptions = {
  newest: 'Recently joined',
  oldest: 'Oldest first',
  name: 'Name A–Z',
  images: 'Most images',
  storage: 'Highest storage usage',
};
export const userFilterKeys = ['status', 'role', 'date', 'from', 'to'] as const;
export function usersURL(current: URL, userId?: string) {
  const parameters = new URLSearchParams();
  for (const key of ['q', ...userFilterKeys, 'tz', 'sort', 'page']) {
    const value = current.searchParams.get(key);
    if (value) parameters.set(key, value);
  }
  const query = parameters.toString();
  return `/admin/users${userId ? '/' + encodeURIComponent(userId) : ''}${query ? '?' + query : ''}`;
}
