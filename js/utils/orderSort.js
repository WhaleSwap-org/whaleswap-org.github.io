export const ORDER_SORTS = Object.freeze({
    BEST_DEAL: 'best-deal',
    WORST_DEAL: 'worst-deal',
    EXPIRES_NEWEST: 'expires-newest',
    EXPIRES_OLDEST: 'expires-oldest'
});

export const DEFAULT_ORDER_SORT = ORDER_SORTS.BEST_DEAL;

export const SORTABLE_ORDER_COLUMNS = Object.freeze({
    DEAL: 'deal',
    EXPIRES: 'expires'
});

export const ORDER_SORT_OPTIONS = Object.freeze([
    { value: ORDER_SORTS.BEST_DEAL, label: 'Best Deal First', column: SORTABLE_ORDER_COLUMNS.DEAL, direction: 'desc' },
    { value: ORDER_SORTS.WORST_DEAL, label: 'Worst Deal First', column: SORTABLE_ORDER_COLUMNS.DEAL, direction: 'asc' },
    { value: ORDER_SORTS.EXPIRES_NEWEST, label: 'Newest First', column: SORTABLE_ORDER_COLUMNS.EXPIRES, direction: 'desc' },
    { value: ORDER_SORTS.EXPIRES_OLDEST, label: 'Oldest First', column: SORTABLE_ORDER_COLUMNS.EXPIRES, direction: 'asc' }
]);

const ORDER_SORT_META = Object.freeze(
    ORDER_SORT_OPTIONS.reduce((accumulator, option) => {
        accumulator[option.value] = option;
        return accumulator;
    }, {})
);

export function normalizeOrderSort(value) {
    return ORDER_SORT_META[value] ? value : DEFAULT_ORDER_SORT;
}

export function getOrderSortMeta(value) {
    return ORDER_SORT_META[normalizeOrderSort(value)];
}

export function getNextOrderSort(currentSort, column) {
    const normalizedSort = normalizeOrderSort(currentSort);
    const currentMeta = getOrderSortMeta(normalizedSort);

    if (column === SORTABLE_ORDER_COLUMNS.DEAL) {
        return currentMeta.column === SORTABLE_ORDER_COLUMNS.DEAL
            ? (normalizedSort === ORDER_SORTS.BEST_DEAL ? ORDER_SORTS.WORST_DEAL : ORDER_SORTS.BEST_DEAL)
            : ORDER_SORTS.BEST_DEAL;
    }

    if (column === SORTABLE_ORDER_COLUMNS.EXPIRES) {
        return currentMeta.column === SORTABLE_ORDER_COLUMNS.EXPIRES
            ? (normalizedSort === ORDER_SORTS.EXPIRES_NEWEST ? ORDER_SORTS.EXPIRES_OLDEST : ORDER_SORTS.EXPIRES_NEWEST)
            : ORDER_SORTS.EXPIRES_NEWEST;
    }

    return normalizedSort;
}

export function renderOrderSortOptions(selectedSort = DEFAULT_ORDER_SORT) {
    const normalizedSort = normalizeOrderSort(selectedSort);
    return ORDER_SORT_OPTIONS.map(({ value, label }) => (
        `<option value="${value}"${value === normalizedSort ? ' selected' : ''}>${label}</option>`
    )).join('');
}

function compareOrderIdsDescending(a, b) {
    return Number(b?.id || 0) - Number(a?.id || 0);
}

function compareSortableNumbers(aValue, bValue, direction, a, b) {
    const aNumber = Number(aValue);
    const bNumber = Number(bValue);
    const aValid = Number.isFinite(aNumber);
    const bValid = Number.isFinite(bNumber);

    if (!aValid && !bValid) {
        return compareOrderIdsDescending(a, b);
    }

    if (!aValid) return 1;
    if (!bValid) return -1;

    if (aNumber !== bNumber) {
        return direction === 'asc' ? aNumber - bNumber : bNumber - aNumber;
    }

    return compareOrderIdsDescending(a, b);
}

export function sortOrdersByCurrentSort(
    orders,
    {
        sortValue,
        getDealSortValue
    }
) {
    const normalizedSort = normalizeOrderSort(sortValue);
    const { column, direction } = getOrderSortMeta(normalizedSort);
    const dealSortAccessor = typeof getDealSortValue === 'function' ? getDealSortValue : () => undefined;

    return [...orders].sort((a, b) => {
        if (column === SORTABLE_ORDER_COLUMNS.DEAL) {
            return compareSortableNumbers(
                dealSortAccessor(a),
                dealSortAccessor(b),
                direction,
                a,
                b
            );
        }

        if (column === SORTABLE_ORDER_COLUMNS.EXPIRES) {
            return compareSortableNumbers(
                a?.id,
                b?.id,
                direction,
                a,
                b
            );
        }

        return compareOrderIdsDescending(a, b);
    });
}
