const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const ethers = {
    constants: {
        AddressZero: '0x0000000000000000000000000000000000000000'
    },
    utils: {
        isAddress(value) {
            return ADDRESS_REGEX.test(String(value || ''));
        },
        getAddress(value) {
            if (!ADDRESS_REGEX.test(String(value || ''))) {
                throw new Error('invalid address');
            }
            return value;
        },
        formatUnits(value) {
            return String(value ?? '0');
        },
        parseUnits(value) {
            return value;
        },
        commify(value) {
            return String(value ?? '');
        }
    }
};

export default { ethers };
