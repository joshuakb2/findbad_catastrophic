# findbad\_catastrophic
Identify damaged files in catastrophically damaged ext2/3/4 filesystem from the ddrescue log

Currently contains hard-coded values for my particular situation.

I have an SSD with about 100 gigabytes of bad sectors (at least according to ddrescue). I was able to recover most of the data in the partition, but I need to know which files are damaged. Normally one would use ddrutility. I tried that... but it appears that ddrutility works by attempting to read each damaged sector one at a time, and figuring out which file the sector belongs to. This was extremely slow. I calculated that it would take 120 years to finish.

So this project takes a different approach. Instead of looking up the file path from the sector, this project scans the filesystem and looks up the locations of each file, and checks whether those locations overlap with any known bad regions. When a large number of sectors are bad, this approach should be much more efficient.
