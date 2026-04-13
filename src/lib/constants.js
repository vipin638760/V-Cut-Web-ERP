export const DEFAULTS_USERS = [
  {id: 'admin001', name: 'Owner', role: 'admin', password: 'VCut@2026', branch_id: 'all'},
  {id: 'acc001', name: 'Accounts Manager', role: 'accountant', password: 'Acc@1234', branch_id: 'all'},
  {id: 'emp001', name: 'SANDY©', role: 'employee', password: 'Sandy@123', branch_id: 'dlf', staff_id: 's1'},
  {id: 'emp002', name: 'FURKAN', role: 'employee', password: 'Furkan@123', branch_id: 'dlfu', staff_id: 's27'},
  {id: 'emp003', name: 'AARIF©', role: 'employee', password: 'Aarif@123', branch_id: 'arek', staff_id: 's8'},
  {id: 'emp004', name: 'ALEEM', role: 'employee', password: 'Aleem@123', branch_id: 'vij', staff_id: 's11'},
  {id: 'emp005', name: 'ZULFEE', role: 'employee', password: 'Zulfee@123', branch_id: 'harl', staff_id: 's20'},
];

export const INR = (v) => { const n = Math.round(v || 0); return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN'); };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
