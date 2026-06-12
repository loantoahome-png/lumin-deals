'use client'

import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'

// Verse of the Day — a curated, offline rotation (no external API). Indexed by
// day-of-year so every team member sees the same verse on a given day, and it
// advances to a different one each morning. ~60 verses → cycles ~6×/year.
//
// Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard
// Version®), © 2001 by Crossway, a publishing ministry of Good News Publishers.
// Used by permission. All rights reserved. (Well within Crossway's gratis-use
// allowance — far fewer than 1,000 verses and not a complete book.)
type Verse = { text: string; ref: string }

const VERSES: Verse[] = [
  { text: 'For I know the plans I have for you, declares the LORD, plans for welfare and not for evil, to give you a future and a hope.', ref: 'Jeremiah 29:11' },
  { text: 'I can do all things through him who strengthens me.', ref: 'Philippians 4:13' },
  { text: 'Trust in the LORD with all your heart, and do not lean on your own understanding. In all your ways acknowledge him, and he will make straight your paths.', ref: 'Proverbs 3:5-6' },
  { text: 'Be strong and courageous. Do not be frightened, and do not be dismayed, for the LORD your God is with you wherever you go.', ref: 'Joshua 1:9' },
  { text: 'But they who wait for the LORD shall renew their strength; they shall mount up with wings like eagles; they shall run and not be weary; they shall walk and not faint.', ref: 'Isaiah 40:31' },
  { text: 'The LORD is my shepherd; I shall not want.', ref: 'Psalm 23:1' },
  { text: 'And we know that for those who love God all things work together for good, for those who are called according to his purpose.', ref: 'Romans 8:28' },
  { text: 'But seek first the kingdom of God and his righteousness, and all these things will be added to you.', ref: 'Matthew 6:33' },
  { text: 'Do not be anxious about anything, but in everything by prayer and supplication with thanksgiving let your requests be made known to God.', ref: 'Philippians 4:6' },
  { text: 'Commit your work to the LORD, and your plans will be established.', ref: 'Proverbs 16:3' },
  { text: 'This is the day that the LORD has made; let us rejoice and be glad in it.', ref: 'Psalm 118:24' },
  { text: 'For we walk by faith, not by sight.', ref: '2 Corinthians 5:7' },
  { text: 'Whatever you do, work heartily, as for the Lord and not for men.', ref: 'Colossians 3:23' },
  { text: 'God is our refuge and strength, a very present help in trouble.', ref: 'Psalm 46:1' },
  { text: 'Fear not, for I am with you; be not dismayed, for I am your God; I will strengthen you, I will help you, I will uphold you with my righteous right hand.', ref: 'Isaiah 41:10' },
  { text: 'Come to me, all who labor and are heavy laden, and I will give you rest.', ref: 'Matthew 11:28' },
  { text: 'Delight yourself in the LORD, and he will give you the desires of your heart.', ref: 'Psalm 37:4' },
  { text: 'And let us not grow weary of doing good, for in due season we will reap, if we do not give up.', ref: 'Galatians 6:9' },
  { text: 'And I am sure of this, that he who began a good work in you will bring it to completion at the day of Jesus Christ.', ref: 'Philippians 1:6' },
  { text: 'Let the favor of the Lord our God be upon us, and establish the work of our hands upon us; yes, establish the work of our hands!', ref: 'Psalm 90:17' },
  { text: 'The plans of the diligent lead surely to abundance, but everyone who is hasty comes only to poverty.', ref: 'Proverbs 21:5' },
  { text: 'If any of you lacks wisdom, let him ask God, who gives generously to all without reproach, and it will be given him.', ref: 'James 1:5' },
  { text: 'I lift up my eyes to the hills. From where does my help come? My help comes from the LORD, who made heaven and earth.', ref: 'Psalm 121:1-2' },
  { text: 'Rejoice in hope, be patient in tribulation, be constant in prayer.', ref: 'Romans 12:12' },
  { text: 'For God gave us a spirit not of fear but of power and love and self-control.', ref: '2 Timothy 1:7' },
  { text: 'Whoever brings blessing will be enriched, and one who waters will himself be watered.', ref: 'Proverbs 11:25' },
  { text: 'The LORD is my strength and my shield; in him my heart trusts, and I am helped; my heart exults, and with my song I give thanks to him.', ref: 'Psalm 28:7' },
  { text: 'Let your light shine before others, so that they may see your good works and give glory to your Father who is in heaven.', ref: 'Matthew 5:16' },
  { text: 'Now faith is the assurance of things hoped for, the conviction of things not seen.', ref: 'Hebrews 11:1' },
  { text: 'I praise you, for I am fearfully and wonderfully made. Wonderful are your works; my soul knows it very well.', ref: 'Psalm 139:14' },
  { text: 'Iron sharpens iron, and one man sharpens another.', ref: 'Proverbs 27:17' },
  { text: 'For we are his workmanship, created in Christ Jesus for good works, which God prepared beforehand, that we should walk in them.', ref: 'Ephesians 2:10' },
  { text: 'I have set the LORD always before me; because he is at my right hand, I shall not be shaken.', ref: 'Psalm 16:8' },
  { text: 'The steadfast love of the LORD never ceases; his mercies never come to an end; they are new every morning; great is your faithfulness.', ref: 'Lamentations 3:22-23' },
  { text: 'I have said these things to you, that in me you may have peace. In the world you will have tribulation. But take heart; I have overcome the world.', ref: 'John 16:33' },
  { text: 'Cast your burden on the LORD, and he will sustain you; he will never permit the righteous to be moved.', ref: 'Psalm 55:22' },
  { text: 'Keep your heart with all vigilance, for from it flow the springs of life.', ref: 'Proverbs 4:23' },
  { text: 'You keep him in perfect peace whose mind is stayed on you, because he trusts in you.', ref: 'Isaiah 26:3' },
  { text: 'Rejoice always, pray without ceasing, give thanks in all circumstances; for this is the will of God in Christ Jesus for you.', ref: '1 Thessalonians 5:16-18' },
  { text: 'A soft answer turns away wrath, but a harsh word stirs up anger.', ref: 'Proverbs 15:1' },
  { text: 'My flesh and my heart may fail, but God is the strength of my heart and my portion forever.', ref: 'Psalm 73:26' },
  { text: 'Do not be grieved, for the joy of the LORD is your strength.', ref: 'Nehemiah 8:10' },
  { text: 'He has told you, O man, what is good; and what does the LORD require of you but to do justice, and to love kindness, and to walk humbly with your God?', ref: 'Micah 6:8' },
  { text: 'May the God of hope fill you with all joy and peace in believing, so that by the power of the Holy Spirit you may abound in hope.', ref: 'Romans 15:13' },
  { text: 'Oh, taste and see that the LORD is good! Blessed is the man who takes refuge in him!', ref: 'Psalm 34:8' },
  { text: 'The heart of man plans his way, but the LORD establishes his steps.', ref: 'Proverbs 16:9' },
  { text: 'Casting all your anxieties on him, because he cares for you.', ref: '1 Peter 5:7' },
  { text: 'The LORD is my light and my salvation; whom shall I fear? The LORD is the stronghold of my life; of whom shall I be afraid?', ref: 'Psalm 27:1' },
  { text: 'Be strong and courageous. Do not fear or be in dread of them, for it is the LORD your God who goes with you. He will not leave you or forsake you.', ref: 'Deuteronomy 31:6' },
  { text: 'Blessed is the man who remains steadfast under trial, for when he has stood the test he will receive the crown of life, which God has promised to those who love him.', ref: 'James 1:12' },
  { text: 'Enter his gates with thanksgiving, and his courts with praise! Give thanks to him; bless his name!', ref: 'Psalm 100:4' },
  { text: 'Do you see a man skillful in his work? He will stand before kings; he will not stand before obscure men.', ref: 'Proverbs 22:29' },
  { text: 'But Jesus looked at them and said, ‘With man this is impossible, but with God all things are possible.’', ref: 'Matthew 19:26' },
  { text: 'Be strong, and let your heart take courage, all you who wait for the LORD!', ref: 'Psalm 31:24' },
  { text: 'But the fruit of the Spirit is love, joy, peace, patience, kindness, goodness, faithfulness, gentleness, self-control; against such things there is no law.', ref: 'Galatians 5:22-23' },
  { text: 'Behold, I am doing a new thing; now it springs forth, do you not perceive it? I will make a way in the wilderness and rivers in the desert.', ref: 'Isaiah 43:19' },
  { text: 'Therefore encourage one another and build one another up, just as you are doing.', ref: '1 Thessalonians 5:11' },
  { text: 'The LORD will fight for you, and you have only to be silent.', ref: 'Exodus 14:14' },
  { text: 'And my God will supply every need of yours according to his riches in glory in Christ Jesus.', ref: 'Philippians 4:19' },
  { text: 'So, whether you eat or drink, or whatever you do, do all to the glory of God.', ref: '1 Corinthians 10:31' },
]

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0)
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000)
}

export default function DailyVerse() {
  // Compute on the client after mount so the day is the user's local day and
  // there is never a server/client hydration mismatch. Until then, show the
  // first verse (a stable placeholder that swaps in-tick to today's).
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(dayOfYear(new Date()) % VERSES.length) }, [])
  const verse = VERSES[idx]

  return (
    <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-gradient-to-r from-orange-50 to-white px-4 py-3">
      <div className="mt-0.5 shrink-0 rounded-lg bg-[#F37021]/10 p-1.5">
        <BookOpen className="h-4 w-4 text-[#F37021]" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#F37021]">Verse of the Day</p>
        <p className="mt-0.5 text-sm italic leading-snug text-slate-700">
          &ldquo;{verse.text}&rdquo;
          <span className="ml-1.5 whitespace-nowrap text-xs font-semibold not-italic text-slate-500">
            — {verse.ref} <span className="text-slate-400">(ESV)</span>
          </span>
        </p>
      </div>
    </div>
  )
}
