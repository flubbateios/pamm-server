class ModListViewmodel {
	constructor(data){
		this.data = data;
		this.searchCategories = ko.mapping.fromJS([
			{display:'Name',name:'display_name'},
			{display:'Author',name:'author'},
			{display:'Identifier',name:'identifier'},
			{display:'Description',name:'description'},
		]);
		this.searchKey = ko.observable('display_name');
		this.searchString = ko.observable('');
		this.processedSearchString = ko.computed(() => {
			return this.searchString().replace(/[^A-Za-z0-9]/g, '').toLowerCase();
		});
		this.mData = ko.mapping.fromJS(this.data);
		this.sortedData = ko.computed(() => {
			const c = ko.mapping.fromJS(data)();
			const n = [];
			for(let x of c){
				x.search_test = x[this.searchKey()]().replace(/[^A-Za-z0-9]/g, '').toLowerCase();
				x.website = x.website || false;
				if(x.search_test.includes(this.processedSearchString())){
					n.push(x);
				}
			}
			return n;
		});
	}
}
window.addEventListener('DOMContentLoaded', () => {
	window.model = new ModListViewmodel(modData);
	ko.applyBindings(model);
});
