# AxiorHub Pseudonymisation Claude - Créé par Timo RAINIO Avocat
# Copyright (C) 2026 Timo RAINIO - Licence AGPL-3.0-or-later (voir LICENSE)
"""Lexiques : prénoms usuels, mots protégés (jamais pris pour des noms de personnes).

Les comparaisons se font sans accent et sans casse (voir textnorm.norm_key).
"""
from __future__ import annotations

from .textnorm import norm_key

_FIRST_NAMES_RAW = """
Jean Pierre Michel André Philippe Alain Bernard Jacques Daniel Christian Patrick Nicolas
François Claude Dominique Laurent Christophe Stéphane Eric Éric Frédéric Olivier Thierry Pascal
Gérard Didier Sébastien Julien David Thomas Antoine Alexandre Vincent Guillaume Maxime Benjamin
Mathieu Romain Kevin Kévin Jérôme Franck Marc Paul Louis Hugo Lucas Nathan Gabriel Arthur Raphaël
Léo Jules Adam Tom Noah Ethan Théo Mathis Enzo Clément Quentin Florian Anthony Jonathan Cédric
Fabrice Sylvain Yves Henri Georges Robert Roger Marcel René Albert Lucien Maurice Raymond Gilbert
Serge Guy Joseph Emmanuel Benoît Bruno Denis Gilles Hervé Joël Lionel Luc Ludovic Martin Mickaël
Michaël Patrice Rémi Rémy Samuel Simon Xavier Yannick Yann Loïc Erwan Gaël Grégory Grégoire
Aurélien Adrien Baptiste Bastien Damien Fabien Jérémy Jeremy Mehdi Karim Mohamed Mohammed Rachid
Samir Nabil Youssef Yassine Ali Omar Hamza Ibrahim Amine Bilal Ismaël Rayan Sofiane Walid Mathias
Matthieu Timothée Timo Tristan Valentin Victor Vivien Alban Alexis Augustin Aymeric Charles Côme
Édouard Edouard Elie Élie Étienne Etienne Félix Gaspard Gautier Geoffrey Geoffroy Guilhem Yohann
Johan Noé Oscar Octave Hippolyte Léon Léonard Marius Maël Nolan Sacha Tiago Mattéo Matteo Lenny
Evan Axel Eliott Elliot Ewen Ilan Isaac Joshua Kylian Liam Logan Malo Milan Naël Nino Robin Ruben
Sam Sami Teo Titouan Wilfried William Zacharie Zakaria Armand Arnaud Boris Cyril Cyrille Dimitri
Donatien Fabio Francis Frédérick Gaétan Gaëtan Gautier Gonzague Gustave Igor Jean-Pierre Jean-Claude
Jean-Marc Jean-Paul Jean-Luc Jean-François Jean-Michel Jean-Louis Jean-Baptiste Jean-Philippe
Jean-Christophe Jean-Jacques Jean-Marie Jean-Yves Jean-Charles Pierre-Yves Pierre-Louis Pierre-Henri
Marc-Antoine Kamel Mourad Nassim Reda Rida Sofian Tarek Tarik Yacine Yanis Adel Hakim Hicham Idriss
Ilyes Ilyès Imad Issam Jamel Khalid Malik Moussa Nadir Nourredine Rayane Riad Said Saïd Salim Selim
Sélim Slimane Soufiane Souleymane Zinedine Abdel Abdelkader Abdallah Abdoulaye Mamadou Ousmane
Aboubacar Bakary Cheikh Ismaïl Lamine Oumar Sékou Seydou Carlos José Juan Manuel Miguel Pedro
Rafael Pablo Diego Mario Marco Luca Giovanni Giuseppe Paolo Andrea Angelo Enrico Fabrizio Franco
Luigi Massimo Roberto Salvatore Stefano Vincenzo John James Michael Peter Richard Steven Mark Andrew
Kenneth Brian George Edward Ronald Anthony Kevin Jason Jeffrey Ryan Jacob Gary Nicholas Eric
Jonathan Stephen Larry Justin Scott Brandon Frank Patrick Raymond Gregory Samuel Dennis Alexander
Patrick Jack Dylan Tyler Aaron Henry Douglas Adam Nathan Zachary Kyle Walter Harold Jeremy Ethan
Carl Keith Roger Gerald Christian Terry Sean Arthur Austin Noah Lawrence Jesse Joe Bryan Billy
Jordan Albert Dylan Bruce Willie Gabriel Alan Juan Logan Wayne Ralph Roy Eugene Randy Vincent
Russell Louis Philip Bobby Johnny Bradley Hans Klaus Jürgen Jurgen Wolfgang Dieter Helmut Werner
Günter Gunter Stefan Andreas Markus Matthias Tobias Florian Sebastian Alexander Maximilian Felix
Lukas Jonas Leon Niklas Moritz Jan Tim Nils Lars Sven Olaf Erik Anders Bjorn Björn Magnus Gustav
Marie Nathalie Isabelle Sylvie Catherine Françoise Martine Christine Monique Nicole Valérie
Sandrine Véronique Stéphanie Sophie Céline Chantal Patricia Anne Brigitte Julie Aurélie Laurence
Annie Émilie Emilie Virginie Corinne Élodie Elodie Camille Caroline Léa Manon Chloé Sarah Laura
Pauline Mathilde Marine Clara Emma Inès Ines Jade Louise Alice Lina Rose Anna Mila Zoé Lola Eva
Juliette Ambre Agathe Romane Lou Léna Lena Lucie Margaux Charlotte Océane Marion Audrey Jessica
Mélanie Laetitia Laëtitia Vanessa Amandine Anaïs Justine Morgane Elsa Noémie Delphine Hélène
Florence Karine Sabrina Nadia Fatima Samira Leïla Leila Yasmine Myriam Amel Khadija Aïcha Aicha
Salma Inaya Sofia Sonia Nadine Jacqueline Jeanne Madeleine Simone Yvonne Denise Suzanne Odette
Germaine Thérèse Marguerite Geneviève Josette Michèle Danielle Claudine Colette Josiane Bernadette
Agnès Béatrice Cécile Claire Clémence Constance Diane Édith Edith Éléonore Eleonore Élise Elise
Estelle Fanny Gaëlle Hortense Iris Joséphine Lise Louna Maëlle Maëlys Margot Maya Mélissa Nina
Olivia Ophélie Perrine Roxane Salomé Solène Victoire Violette Marie-Claire Marie-Christine
Marie-France Marie-Hélène Marie-Laure Marie-Pierre Marie-Thérèse Marie-Agnès Marie-Odile
Marie-Noëlle Marie-Paule Marie-Josée Marie-Line Anne-Marie Anne-Sophie Anne-Laure Anne-Claire
Alexandra Alexia Alicia Alison Amélie Amelie Anaëlle Andrée Angélique Annick Annabelle Ariane
Armelle Astrid Aurore Axelle Barbara Bénédicte Carine Carla Carole Cassandra Cathy Célia Célina
Chiara Christelle Christiane Cindy Clarisse Coralie Cynthia Daphné Déborah Dorothée Édwige Elena
Éléna Eliane Éliane Élisabeth Elisabeth Elsa Émeline Emeline Émilienne Emma Émma Fabienne
Fatiha Faustine Flavie Fleur Flora Francine Frédérique Gabrielle Garance Ghislaine Gisèle Gwendoline
Hanaé Héloïse Huguette Ilona Imane Ingrid Irène Isabel Jennifer Jocelyne Johanna Joëlle Julia
Karima Kenza Laurie Léonie Lila Lilou Lison Loubna Lydie Lyna Maëva Magali Maïa Malika Marianne
Marielle Marilyne Marina Marjorie Marlène Maryse Maud Mélina Mélodie Micheline Mireille Muriel
Mylène Nadège Naïma Nawel Nelly Nour Odile Oriane Paola Pascale Pénélope Priscilla Rachel Raphaëlle
Rebecca Régine Renée Rim Romy Rosalie Sabine Sabrina Safia Salima Samia Sandra Sarra Séverine
Sihem Sixtine Soraya Stella Suzie Sylviane Tatiana Thaïs Tiphaine Valentine Vanina Virginie Wafa
Yolande Zahra Zineb Zohra Elena Francesca Giulia Chiara Maria Sofia Laura Anna Sara Giorgia Martina
Valentina Alessia Carmen Lucia Ana Isabel Pilar Dolores Rosa Teresa Elena Mary Patricia Jennifer
Linda Elizabeth Susan Jessica Karen Nancy Lisa Betty Sandra Ashley Kimberly Donna Carol Michelle
Amanda Melissa Deborah Stephanie Rebecca Sharon Laura Cynthia Kathleen Amy Angela Shirley Anna
Brenda Pamela Emma Nicole Helen Samantha Katherine Christine Debra Rachel Carolyn Janet Catherine
Maria Heather Diane Ruth Julie Olivia Joyce Virginia Victoria Kelly Lauren Christina Joan Evelyn
Judith Megan Andrea Cheryl Hannah Jacqueline Martha Gloria Teresa Ann Sara Madison Frances
Kathryn Janice Jean Abigail Alice Judy Sophia Grace Denise Amber Doris Marilyn Danielle Beverly
Isabella Theresa Diana Natalie Brittany Charlotte Marie Kayla Alexis Lori Petra Sabine Ute Monika
Karin Birgit Heike Claudia Katrin Julia Anja Nicole Stefanie Sandra Nadine Lena Sarah Hannah Lea
Leonie Lara Mia Emilia Ida Ingrid Astrid Sigrid Helga Greta Freya Elin Maja Linnea Ebba
"""

FIRST_NAMES: frozenset[str] = frozenset(norm_key(n) for n in _FIRST_NAMES_RAW.split())

#: Mots en capitales qui ne sont jamais des noms de personnes (sigles, droit, paie, institutions).
_UPPER_STOPWORDS_RAW = """
PERSONNE SOCIETE EMAIL TEL ADRESSE IBAN SIREN SIRET NIR URL UTILISATEUR IP RG PORTALIS RPPS SINISTRE IMMATRICULATION
IDCC SYNTEC CSG CRDS PMSS PASS SMIC RTT CDD CDI CSE CHSCT PSE OPCO AFPA APEC RSA AAH ASPA PUMA AME
AGIRC ARRCO DSN DPAE ECLI DRH DAF DG DGA PDG DSI RH URSSAF CPAM CAF MSA CARSAT CNAV CNAM POLE EMPLOI
TGI TJ TA CAA CE CA CPH TASS TCI JAF JEX JLD JI JAP RG RGPD CNIL INPI INSEE SIREN SIRET TVA HT TTC
NIR NIF IBAN BIC RIB SWIFT CB CCP SA SAS SASU SARL EURL SCI SCM SCP SNC SELARL SELAS SELAFA SELCA
SEL GIE SCA SCS SEM SCOP SASP EPIC EPA EPIC GIP OPH HLM SEMOP SPL SPLA SIVU SIVOM EPCI ONG SA RL
UE EU ONU OTAN OCDE OMC OMS FMI BCE BEI CEDH CJUE CJCE TUE TFUE TPIUE CEE CEDEAO
SNCF RATP EDF GDF ENGIE ORANGE SFR FREE BOUYGUES VINCI TOTAL BNP SG LCL HSBC AXA MAIF MACIF MMA
GMF MAAF ALLIANZ GENERALI COVEA GROUPAMA CNP PDF DOC DOCX XLS XLSX PPT PPTX CSV TXT ZIP RAR URL
URI HTTP HTTPS FTP SSH API JSON XML HTML CSS SQL PHP JAVA SDK CLI IDE OS PC MAC IOS LINUX WINDOWS
UNIX USB CPU GPU RAM SSD HDD DNS IP VPN LAN WAN WIFI BT GPS NFC RFID AI IA LLM GPT
LOI CODE ARTICLE ART AL ALINEA CIV COM SOC CRIM CASS CONS CONST CC CCASS CEDH JCP RTD AJDA LPA
BULL DALLOZ LEXIS LAMY JURIS JURISPRUDENCE GAZ PAL RJS RDT RDC RDI RTDCIV RTDCOM RJDA BRDA
AVIS ARRET ARRÊT JUGEMENT ORDONNANCE DECISION DÉCISION CONCLUSIONS ASSIGNATION REQUETE REQUÊTE
CITATION SIGNIFICATION NOTIFICATION MISE DEMEURE SOMMATION PROTOCOLE CONVENTION CONTRAT AVENANT
TRIBUNAL COUR APPEL CASSATION CONSEIL ETAT ÉTAT REPUBLIQUE RÉPUBLIQUE FRANCAISE FRANÇAISE FRANCE
PARIS LYON MARSEILLE LILLE BORDEAUX NANTES TOULOUSE NICE STRASBOURG RENNES MONTPELLIER GRENOBLE
PLAISE MOTIFS DISPOSITIF FAITS PROCEDURE PROCÉDURE DISCUSSION MOYENS PRETENTIONS PRÉTENTIONS
EXPOSE EXPOSÉ RAPPEL OBJET PIECE PIÈCE PIECES PIÈCES ANNEXE ANNEXES BORDEREAU TOTAL NET BRUT
MONTANT DATE LIEU HEURE ENTRE ET OU LE LA LES DE DES DU EN UN UNE PAR SUR POUR AVEC SANS DANS
AU AUX CES CET CETTE SON SA SES LEUR LEURS NOTRE VOTRE NOS VOS MON MA MES TON TA TES CE QUI QUE
DONT NE PAS NI OR CAR DONC MAIS SI TRES TRÈS PLUS MOINS TOUT TOUS TOUTE TOUTES AUTRE AUTRES
JANVIER FEVRIER FÉVRIER MARS AVRIL MAI JUIN JUILLET AOUT AOÛT SEPTEMBRE OCTOBRE NOVEMBRE DECEMBRE
DÉCEMBRE LUNDI MARDI MERCREDI JEUDI VENDREDI SAMEDI DIMANCHE
II III IV VI VII VIII IX XI XII XIII XIV XV XVI XVII XVIII XIX XX XXI
NORD SUD EST OUEST CEDEX BP CS TSA EUR USD GBP CHF EURO EUROS
MONSIEUR MADAME MADEMOISELLE MAITRE MAÎTRE DOCTEUR PROFESSEUR SOCIETE SOCIÉTÉ CABINET AVOCAT
AVOCATS HUISSIER NOTAIRE GREFFE GREFFIER PRESIDENT PRÉSIDENT JUGE MAGISTRAT PROCUREUR BATONNIER
BÂTONNIER ORDRE BARREAU CNB CNBF CARPA UNCA ENM EFB HEDAC EDA
DEMANDEUR DEMANDERESSE DEFENDEUR DÉFENDEUR DEFENDERESSE DÉFENDERESSE APPELANT APPELANTE INTIME
INTIMÉ INTIMEE INTIMÉE REQUERANT REQUÉRANT PARTIE PARTIES CLIENT CLIENTE DOSSIER AFFAIRE
SALARIE SALARIÉ EMPLOYEUR BAILLEUR LOCATAIRE PRENEUR VENDEUR ACQUEREUR ACQUÉREUR ACHETEUR
ASSUREUR ASSURE ASSURÉ VICTIME PREVENU PRÉVENU ACCUSE ACCUSÉ TEMOIN TÉMOIN EXPERT MANDATAIRE
LIQUIDATEUR ADMINISTRATEUR SYNDIC GERANT GÉRANT DIRECTEUR DIRECTRICE
"""

UPPER_STOPWORDS: frozenset[str] = frozenset(norm_key(w) for w in _UPPER_STOPWORDS_RAW.split())

#: Mots en casse de titre qui ne peuvent pas être le nom de famille d'un « Prénom Nom ».
_TITLE_STOPWORDS_RAW = """
janvier février fevrier mars avril mai juin juillet août aout septembre octobre novembre décembre
decembre lundi mardi mercredi jeudi vendredi samedi dimanche
code civil pénal penal commerce travail cour tribunal conseil état etat chambre sociale article loi
décret decret arrêté arrete ordonnance jugement arrêt arret paris lyon marseille lille bordeaux
nantes toulouse nice strasbourg rennes montpellier grenoble france français francais française
francaise monsieur madame mademoiselle maître maitre docteur société societe cabinet avocat avocats
sas sarl le la les des du de et ou en au aux un une pour par sur sous dans avec sans chez vers entre
selon depuis pendant contre lorsque quand comme mais donc car ni or si que qui dont est sont ont
fait faire dit doit peut sera avait était etait été ete ayant étant etant demande demandeur
défendeur defendeur appelant intimé intime partie parties client cliente dossier affaire audience
juge président president greffier huissier notaire expert témoin temoin victime prévenu prevenu
accusé accuse requérant requerant salarié salarie employeur bailleur locataire vendeur acheteur
banque assurance assureur mutuelle caisse direction service groupe entreprise holding international
industries consulting capital finance immobilier europe européen europeen européenne europeenne
union république republique nation nationale national ministère ministere ministre préfecture
prefecture préfet prefet mairie maire commune département departement région region rue avenue
boulevard place chemin route nord sud ouest saint sainte bonjour merci cordialement sincères
directeur directrice gérant gérante gerant gerante présidente presidente secrétaire secretaire
responsable chef cheffe conseiller conseillère conseillere rapporteur rapporteure bâtonnier batonnier
bâtonnière batonniere procureur procureure substitut greffière greffiere magistrat magistrate ministre
préfet prefet préfète prefete commissaire inspecteur inspectrice médecin medecin avocate notaire
mandataire liquidateur administrateur administratrice syndic trésorier tresorier trésorière tresoriere
associé associe associée associee actionnaire salariée salariee employé employe employée employee
ouvrier ouvrière ouvriere cadre agent agente propriétaire proprietaire assuré assure assurée assuree
défenderesse defenderesse demanderesse appelante intimée intimee requérante requerante prévenue
prevenue accusée accusee témoin temoin partie adverse signataire soussigné soussigne soussignée
soussignee gardien gardienne tuteur tutrice curateur curatrice héritier heritier héritière heritiere
époux epoux épouse epouse conjoint conjointe concubin concubine père pere mère mere fils fille enfant
mineur mineure majeur majeure
sinceres salutations objet pièce piece pièces pieces annexe réf ref référence reference
valjean
"""

TITLE_STOPWORDS: frozenset[str] = frozenset(norm_key(w) for w in _TITLE_STOPWORDS_RAW.split()) - {"valjean"}

#: Particules admises à l'intérieur d'un nom (« Jean de La Fontaine », « DE LA TOUR »).
NAME_PARTICLES: frozenset[str] = frozenset(
    "de du des le la les van von der den di da del della d' d’ l' l’ ben bin al el".split()
)

#: Civilités reconnues (le texte conservé devant le marqueur).
CIVILITIES: tuple[str, ...] = (
    "Monsieur", "Madame", "Mademoiselle", "Messieurs", "Mesdames",
    "M.", "MM.", "Mme", "Mmes", "Mlle", "Mlles", "Mr", "Mrs", "Ms",
    "Maître", "Maitre", "Me", "Mes",
    "Docteur", "Dr", "Professeur", "Pr",
)

#: Civilités d'avocat : une personne désignée ainsi n'est jamais rapprochée d'un homonyme.
LAWYER_CIVILITIES: frozenset[str] = frozenset(norm_key(c) for c in ("Maître", "Maitre", "Me", "Mes"))

#: Formes juridiques de sociétés.
COMPANY_FORMS: tuple[str, ...] = (
    "SASU", "SAS", "SARL", "EURL", "SELARL", "SELAS", "SELAFA", "SELCA", "SCI", "SCM", "SCP", "SNC",
    "SCA", "SCS", "SEM", "SCOP", "SASP", "GIE", "SA", "SE", "GmbH", "AG", "Ltd", "LLC", "Inc",
    "Inc.", "BV", "NV", "SpA", "Srl", "PLC", "Sàrl", "Sarl",
)

#: Mots introduisant un nom de société.
COMPANY_INTRODUCERS: tuple[str, ...] = (
    "société", "societe", "entreprise", "compagnie", "groupe", "cabinet", "association", "holding",
    "établissement", "etablissement", "enseigne", "marque", "Société", "Entreprise", "Compagnie", "Groupe", "Cabinet", "Association", "Holding", "SCI", "SAS", "SASU", "SARL", "SA",
    "EURL", "SELARL", "SELAS", "SNC", "GIE",
)


def is_first_name(token: str) -> bool:
    """Vrai si le jeton (éventuellement composé « Jean-Pierre ») est un prénom usuel."""
    key = norm_key(token)
    if key in FIRST_NAMES:
        return True
    if "-" in key:
        parts = [p for p in key.split("-") if p]
        return bool(parts) and all(p in FIRST_NAMES for p in parts)
    return False


def is_upper_stopword(token: str) -> bool:
    return norm_key(token.replace("’", "'")) in UPPER_STOPWORDS


def is_title_stopword(token: str) -> bool:
    return norm_key(token) in TITLE_STOPWORDS
