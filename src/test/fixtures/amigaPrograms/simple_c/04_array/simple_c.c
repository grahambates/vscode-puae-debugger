__attribute__((optimize("no-tree-loop-distribute-patterns"))) 
void* memcpy(void *dest, const void *src, unsigned long len) {
	char *d = (char *)dest;
	const char *s = (const char *)src;
	while(len--)
		*d++ = *s++;
	return dest;
}

__attribute__((used)) __attribute__((section(".text.unlikely"))) void _start() {
	int array[] = { 
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		11, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		21, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		31, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		41, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		51, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		61, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		71, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		81, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		91, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		101, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		111, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
		121, 2, 3, 4, 5, 6, 7, 8, 9, 10,  
	};
	while(1) {}
}